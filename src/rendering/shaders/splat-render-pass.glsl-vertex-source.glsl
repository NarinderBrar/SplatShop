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
  vec2 clipOffset = corner * pixelRadius * 2.0 / viewport * centerClip.w;

  gl_Position = vec4(centerClip.xy + clipOffset, centerClip.zw);
  vCorner = corner;
  vColor = splatColor;
}
