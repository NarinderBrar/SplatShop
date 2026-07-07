precision highp float;

varying vec2 vCorner;
varying vec4 vColor;

uniform float vizMode;
uniform float minAlpha;
uniform float blurAmount;

const float EXP4 = 0.01831563888873418;
const float INV_ONE_MINUS_EXP4 = 1.018657360363774;

float normExp(float x) {
  return (exp(-4.0 * x) - EXP4) * INV_ONE_MINUS_EXP4;
}

void main(void) {
  float radius2 = dot(vCorner, vCorner);
  if (radius2 > 1.0) {
    discard;
  }

  float splatAlpha = clamp(vColor.a, 0.0, 1.0);
  float effectiveAlpha = vizMode == 1.0 ? 1.0 : splatAlpha;
  float blurScale = max(0.5, blurAmount);
  float alpha = normExp(radius2 / (blurScale * blurScale)) * effectiveAlpha;
  if (alpha < max(minAlpha, __GLSL_FRAGMENT_SOURCE_EXPR_0__)) {
    discard;
  }
  gl_FragColor = vec4(max(vColor.rgb, vec3(0.0)) * alpha, alpha);
}
