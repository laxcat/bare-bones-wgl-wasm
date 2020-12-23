#include <emscripten/emscripten.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>


using byte = uint8_t;


struct DotVert {
  float x, y, z;
};


struct Globals {
  double startTime;
  double thisTime;
  double deltaTime;
  uint32_t dotVertCount;
  void * dynamic;
  DotVert * dotVerts;
};
Globals g;




// JS INTERFACE
extern "C" {

  void * EMSCRIPTEN_KEEPALIVE init(double startTime) {
    g.startTime = startTime;
    g.thisTime = g.startTime;
    g.deltaTime = 0;
    g.dotVertCount = 1000000;
    g.dynamic = malloc(24*1024*1024);
    g.dotVerts = (DotVert *)g.dynamic;
    for (int i = 0; i < g.dotVertCount; ++i) {
      g.dotVerts[i].x = (float)(i);
    }
    return (void *)&g;
  }

  void EMSCRIPTEN_KEEPALIVE tick() {
  }
}

