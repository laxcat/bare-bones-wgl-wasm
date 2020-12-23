'use strict';


const clog = (msg) => {
  msg = '%c' + msg;
  console.log(msg, 'font-family:Menlo,Consolas,monospace;');
}
const elog = (msg) => {
  msg = '%c' + msg;
  console.error(msg, 'font-family:Menlo,Consolas,monospace;');
}


class ShaderProgram {

  gl;
  vertShader;
  fragShader;
  shaderProgram;

  constructor(gl) {
    this.gl = gl;
  }

  loadAndCompile = (vertFilename, fragFilename) => {
    const getVert = fetch(vertFilename).then(r => r.text());
    const getFrag = fetch(vertFilename).then(r => r.text());
    return Promise.all(getVert, getFrag).then(results => this.compile(...results));
  }

  compile = (vertSrc, fragSrc) => {
      this.vertShader = this.gl.createShader(this.gl.VERTEX_SHADER);
      this.gl.shaderSource(this.vertShader, vertSrc);
      this.gl.compileShader(this.vertShader);

      this.fragShader = this.gl.createShader(this.gl.FRAGMENT_SHADER);
      this.gl.shaderSource(this.fragShader, fragSrc);
      this.gl.compileShader(this.fragShader);

      this.shaderProgram = this.gl.createProgram();
      this.gl.attachShader(this.shaderProgram, this.vertShader);
      this.gl.attachShader(this.shaderProgram, this.fragShader);
      this.gl.linkProgram(this.shaderProgram);
      if (!this.gl.getProgramParameter(this.shaderProgram, this.gl.LINK_STATUS)) {
        const info = this.gl.getProgramInfoLog(this.shaderProgram);
        throw 'Could not compile WebGL program. \n\n' + info;
      }
    }
};


class WASMMem {
  ptr;
  times;
  vertCounts;
  dynamic;
  textVerts;
  rawBuffer;
  constructor(ptr_, rawBuffer) {
    this.ptr = ptr_;
    this.rawBuffer = rawBuffer;
    let next = this.ptr;
    this.times = new Float64Array(rawBuffer, next, 3);
    next += this.times.byteLength;
    this.vertCounts = new Uint32Array(rawBuffer, next, 1);
    next += this.vertCounts.byteLength;
    this.dynamic = (new Uint32Array(rawBuffer, next, 1))[0];
    this.textVerts = new Float32Array(rawBuffer, this.dynamic, this.textVertCount);
  }
  get startTime()  { return this.times[0]; }
  set startTime(t) { this.times[0] = t; }
  get thisTime()   { return this.times[1]; }
  set thisTime(t)  { this.times[1] = t; }
  get deltaTime()  { return this.times[2]; }
  set deltaTime(t) { this.times[2] = t; }
  get textVertCount() { return this.vertCounts[0]; }
};


// WebGL/WebAssembly controller
class WGLASM {

  glContext = null;
  glShaderPrograms = [];
  
  wasmEnv;
  wasmImportObject;
  wasmExports;
  wasmBuffer = {raw: null, array: null};
  wasmMem;
  textDecoder;

  startTime;
  thisTime;
  deltaTime;

  manager;

  constructor(init) {
    // error out if missing components of init object
    if (
      !init.wasm ||
      !init.canvas || 
      !init.manager || 
      !init.shaders || 
      !init.shaders.hasOwnProperty('length') || 
      init.shaders.length == 0 ||
      !init.shaders[0].vert || 
      !init.shaders[0].frag
      ) {
      const e = "Missing required elements in init object. Example:\n" +
      "{\n" +
      "  wasm: 'main.wasm',                                 // a filename\n" +
      "  shaders: [{vert:'vert.glsl', frag:'frag.glsl'},],  // an array of objects with filenames\n" +
      "  canvas: document.getElementById('gl'),             // an element reference\n" +
      "  manager: Game,                                     // a classname\n" +
      "}";
      elog(e);
      return;
    }

    // initialize everything we can, now, before loading
    this.manager = init.manager;
    this.textDecoder = new TextDecoder();
    this.glContext = init.canvas.getContext('webgl');
    this.vaoExt = this.glContext.getExtension('OES_vertex_array_object');
    this.wasmEnv = {
      args_sizes_get: (...a) => 0,
      args_get: (...a) => 0,
      proc_exit: (...a) => 0,
      environ_sizes_get: (...a) => 0,
      environ_get: (...a) => 0,
      fd_close: (...a) => 0,
      fd_seek: (...a) => 0,
      fd_write: (fd, iovs, iovsLen, nwritten) => {
        let view = new DataView(this.wasmBuffer.raw);
        let written = 0;
        let bufferBytes = [];
        const buffers = Array.from({ length: iovsLen }, (_, i) => {
          const ptr = iovs + i * 8;
          const buf = view.getUint32(ptr, true);
          const bufLen = view.getUint32(ptr + 4, true);
          return new Uint8Array(this.wasmBuffer.raw, buf, bufLen);
        });
        const writev = iov => {
          for (var b = 0; b < iov.byteLength; b++) {
            bufferBytes.push(iov[b]);
          }
          written += b;
        };
        buffers.forEach(writev);
        if (fd === 1) console.log(String.fromCharCode.apply(null, bufferBytes));
        view.setUint32(nwritten, written, true);
        return 0;
      },
      // memory: new WebAssembly.Memory({initial:32}),
    };
    this.wasmImportObject = { 
      env: this.wasmEnv,
      wasi_snapshot_preview1: this.wasmEnv,
    };

    // gather shader filenames
    let shaderFilenames = [];
    init.shaders.forEach(fname => {
      if (!shaderFilenames.includes(fname.vert)) {
        shaderFilenames.push(fname.vert);
      }
      if (!shaderFilenames.includes(fname.frag)) {
        shaderFilenames.push(fname.frag);
      }
    });

    // construct array of promises for all our loading/initializing
    let allFilesToLoad = [];
    // add the wasm
    allFilesToLoad.push(
      fetch(init.wasm)
      .then(r => r.arrayBuffer())
      .then(bytes => WebAssembly.instantiate(bytes, this.wasmImportObject))
    );
    // add the shaders
    shaderFilenames.forEach(fname => {
      allFilesToLoad.push(fetch(fname).then(r => r.text().then(t => { return {name: `${fname}`, src: t}; })));
    });

    // run our promises, and run all instantiation code after
    Promise.all(allFilesToLoad).then(loaded => {

      // ok everything we need to start rendering and calling the wasm
      // is loaded. do the final initialization

      // remove wasm obj, remove it from loaded array, which should now just
      // be objects with (uncompiled) shader code
      const wasmObj = loaded[0];
      loaded.shift();

      // capture what we need from the wasm instance
      this.wasmExports = wasmObj.instance.exports;
      this.wasmBuffer.raw = this.wasmExports.memory.buffer;
      this.wasmBuffer.array = new Uint8Array(this.wasmBuffer.raw);

      // compile our loaded shaders
      init.shaders.forEach(shaderObj => {
        const vertSrc = loaded.find(el => el.name === shaderObj.vert).src;
        const fragSrc = loaded.find(el => el.name === shaderObj.frag).src;
        const program = new ShaderProgram(this.glContext);
        program.compile(vertSrc, fragSrc);
        this.glShaderPrograms.push(program);
      });

      // opengl
      this.glContext.clearColor(0.15, 0.00, 0.20, 1.00);
      this.glContext.clear(this.glContext.COLOR_BUFFER_BIT);

      // time
      this.startTime = 
      this.thisTime = performance.now();
      
      // init
      const globalsPtr = this.wasmExports.init(this.startTime);
      this.manager.init(this);

      // setup shared memory structure
      this.mem = new WASMMem(globalsPtr, this.wasmBuffer.raw);

      // tick. call right away
      this.wasmExports.tick(this.startTime);
      this.manager.tick(this.thisTime);
      window.requestAnimationFrame(this.tick);
    });
  }


  tick = () => {
    const t = performance.now();
    this.mem.deltaTime = t - this.mem.thisTime;
    this.mem.thisTime = t;

    this.wasmExports.tick();
    this.manager.tick();

    window.requestAnimationFrame(this.tick);
  }

  getString = (ptr) => {
    let len = 0;
    const arr = this.wasmBuffer.array;
    while (ptr + len < arr.length && arr[ptr + len] !== 0) ++len;
    let str = new Uint8Array(this.wasmBuffer.raw, ptr, len);
    return this.textDecoder.decode(str);
  };


};