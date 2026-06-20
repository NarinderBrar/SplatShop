precision highp float;

varying vec2 vUV;
uniform sampler2D textureSampler;
uniform float time;
uniform float strength;

void main(void) {
  vec4 color = texture2D(textureSampler, vUV);
  float vignette = smoothstep(0.92, 0.2, distance(vUV, vec2(0.5)));
  float pulse = 0.5 + 0.5 * sin(time * 0.9);
  vec3 warmLift = vec3(0.06, 0.025, -0.015) * strength * pulse;
  gl_FragColor = vec4(color.rgb * (0.82 + 0.18 * vignette) + warmLift, color.a);
}
