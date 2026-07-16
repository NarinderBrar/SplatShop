struct Uniforms {
  worldViewProjection: mat4x4f,
  view: mat4x4f,
  world: mat4x4f,
  projection: mat4x4f,
  viewportGaussianMinRadius: vec4f,
  quality: vec4f,
  render: vec4f,
  fragment: vec4f,
  meansMin: vec4f,
  meansMax: vec4f,
  offsets0: vec4f,
  offsets1: vec4f,
};

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) corner: vec2f,
  @location(1) color: vec4f,
};

const SPLATS_PER_INSTANCE: u32 = 128u;
const SPLAT_STATE_SELECTED: u32 = 1u;
const SPLAT_STATE_RENDER_DISABLED: u32 = 26u;
const CHUNK_SIZE: u32 = 4096u;

fn quadCorner(vertexIndex: u32) -> vec2f {
  let cornerIndex = vertexIndex % 6u;
  if (cornerIndex == 0u) { return vec2f(-1.0, -1.0); }
  if (cornerIndex == 1u) { return vec2f( 1.0, -1.0); }
  if (cornerIndex == 2u) { return vec2f( 1.0,  1.0); }
  if (cornerIndex == 3u) { return vec2f(-1.0, -1.0); }
  if (cornerIndex == 4u) { return vec2f( 1.0,  1.0); }
  return vec2f(-1.0, 1.0);
}

fn hiddenVertex() -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4f(0.0, 0.0, 2.0, 1.0);
  output.corner = vec2f(2.0);
  output.color = vec4f(0.0);
  return output;
}

fn displayColor(baseColor: vec4f, state: u32, sourceIndex: u32, colorGroup: u32) -> vec4f {
  var result = baseColor;
  let vizMode = uniforms.render.y;
  if (vizMode == 2.0) {
    let id = f32(sourceIndex / CHUNK_SIZE);
    result = vec4f(
      fract(sin(id * 12.9898 + 1.0) * 43758.5453),
      fract(sin(id * 78.233 + 2.0) * 43758.5453),
      fract(sin(id * 45.164 + 3.0) * 43758.5453),
      1.0,
    );
  } else if (vizMode == 3.0) {
    let id = f32(colorGroup);
    result = vec4f(
      fract(sin(id * 12.9898 + 1.0) * 43758.5453),
      fract(sin(id * 78.233 + 2.0) * 43758.5453),
      fract(sin(id * 45.164 + 3.0) * 43758.5453),
      1.0,
    );
  }
  if ((state & SPLAT_STATE_SELECTED) != 0u) {
    result = vec4f(mix(result.rgb, vec3f(0.3, 1.0, 0.4), 0.8), 1.0);
  }
  return result;
}

fn splatPosition(center: vec3f, rotation: vec4f, scale: vec3f, corner: vec2f, centerClip: vec4f) -> vec4f {
  if (uniforms.render.y >= 1.0) {
    let offset = corner * 4.0 / uniforms.viewportGaussianMinRadius.xy * centerClip.w;
    return vec4f(centerClip.xy + offset, centerClip.zw);
  }

  let modelView = uniforms.view * uniforms.world;
  let centerView = modelView * vec4f(center, 1.0);
  if (uniforms.projection[3][3] != 1.0 && centerView.z <= 0.0) {
    return vec4f(0.0, 0.0, 2.0, 1.0);
  }

  let w = rotation.x;
  let x = rotation.y;
  let y = rotation.z;
  let z = rotation.w;
  let r = mat3x3f(
    vec3f(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y)),
    vec3f(2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x)),
    vec3f(2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y)),
  );
  let m = mat3x3f(r[0] * scale.x, r[1] * scale.y, r[2] * scale.z);
  let covariance3d = m * transpose(m);
  let cameraRotation = transpose(mat3x3f(modelView[0].xyz, modelView[1].xyz, modelView[2].xyz));
  let focal = uniforms.viewportGaussianMinRadius.x * uniforms.projection[0][0];
  let viewCenter = centerView.xyz / centerView.w;
  let j1 = focal / viewCenter.z;
  let j2 = -j1 / viewCenter.z * viewCenter.xy;
  let jacobian = mat3x3f(vec3f(j1, 0.0, j2.x), vec3f(0.0, j1, j2.y), vec3f(0.0));
  let transform = cameraRotation * jacobian;
  let covariance = transpose(transform) * covariance3d * transform;
  let diagonal1 = covariance[0][0] + uniforms.quality.w;
  let offDiagonal = covariance[0][1];
  let diagonal2 = covariance[1][1] + uniforms.quality.w;
  let midpoint = 0.5 * (diagonal1 + diagonal2);
  let radius = length(vec2f((diagonal1 - diagonal2) * 0.5, offDiagonal));
  let lambda1 = midpoint + radius;
  let lambda2 = max(midpoint - radius, 0.1);
  let maxRadius = min(uniforms.quality.x, min(1024.0, min(uniforms.viewportGaussianMinRadius.x, uniforms.viewportGaussianMinRadius.y)));
  let extent1 = min(max(0.5, uniforms.quality.y) * sqrt(lambda1), maxRadius);
  let extent2 = min(max(0.5, uniforms.quality.y) * sqrt(lambda2), maxRadius);
  let maxExtent = max(extent1, extent2);
  if (maxExtent < uniforms.viewportGaussianMinRadius.w) {
    return vec4f(0.0, 0.0, 2.0, 1.0);
  }

  let clipCenter = vec4f(centerClip.xy, clamp(centerClip.z, 0.0, abs(centerClip.w)), centerClip.w);
  if (any(abs(clipCenter.xy) - vec2f(maxExtent) * clipCenter.w / uniforms.viewportGaussianMinRadius.xy > vec2f(clipCenter.w * uniforms.quality.z))) {
    return vec4f(0.0, 0.0, 2.0, 1.0);
  }

  let axis = normalize(vec2f(offDiagonal, lambda1 - diagonal1));
  let axis1 = extent1 * axis;
  let axis2 = extent2 * vec2f(axis.y, -axis.x);
  let offset = (corner.x * axis1 + corner.y * axis2) * clipCenter.w / uniforms.viewportGaussianMinRadius.xy;
  return vec4f(clipCenter.xy + offset, clipCenter.zw);
}
