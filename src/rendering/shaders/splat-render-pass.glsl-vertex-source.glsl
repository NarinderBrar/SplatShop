precision highp float;

attribute vec3 position;
attribute vec2 corner;
attribute vec4 splatColor;
attribute float splatScale;

uniform mat4 worldViewProjection;
uniform vec2 viewport;
uniform float gaussianScale;
uniform float minPixelRadius;
uniform float maxPixelRadius;
uniform float clipXY;
uniform float vizMode;

varying vec2 vCorner;
varying vec4 vColor;

void main(void) {
  vec4 centerClip = worldViewProjection * vec4(position, 1.0);
  float pixelRadius;
  if (vizMode >= 1.0) {
    pixelRadius = 2.0;
  } else {
    pixelRadius = clamp(exp(splatScale) * gaussianScale, minPixelRadius, maxPixelRadius);
  }
  if (abs(centerClip.x) - pixelRadius * centerClip.w / viewport.x > centerClip.w * clipXY ||
      abs(centerClip.y) - pixelRadius * centerClip.w / viewport.y > centerClip.w * clipXY) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vCorner = vec2(2.0);
    vColor = vec4(0.0);
    return;
  }
  vec2 clipOffset = corner * pixelRadius * 2.0 / viewport * centerClip.w;

  gl_Position = vec4(centerClip.xy + clipOffset, centerClip.zw);
  vCorner = corner;
  vColor = splatColor;
}
