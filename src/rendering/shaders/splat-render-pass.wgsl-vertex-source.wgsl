attribute position: vec3f;

uniform worldViewProjection: mat4x4f;
uniform view: mat4x4f;
uniform world: mat4x4f;
uniform projection: mat4x4f;
uniform viewport: vec2f;
uniform gaussianScale: f32;
uniform minPixelRadius: f32;
uniform maxPixelRadius: f32;
uniform renderSplatCount: f32;
uniform vizMode: f32;

var<storage, read> centerScaleBuffer: array<vec4f>;
var<storage, read> scaleBuffer: array<vec4f>;
var<storage, read> rotationBuffer: array<vec4f>;
var<storage, read> colorBuffer: array<vec4f>;
var<storage, read> colorGroupBuffer: array<u32>;
var<storage, read> splatStateBuffer: array<u32>;
var<storage, read> indexBuffer: array<u32>;

varying vCorner: vec2f;
varying vColor: vec4f;

const CHUNK_SIZE: u32 = 4096u;
const SPLAT_STATE_SELECTED: u32 = 1u;
const SPLAT_STATE_RENDER_DISABLED: u32 = 26u;

#define CUSTOM_VERTEX_DEFINITIONS

fn initCornerCov(
  centerScale: vec3f, 
  rotation: vec4f, 
  scale: vec3f, 
  corner: vec2f, 
  centerClip: vec4f,
  projMat00: f32,
  modelView: mat4x4f
) -> vec4f {
  let w = rotation.x;
  let x = rotation.y;
  let y = rotation.z;
  let z = rotation.w;

  // Babylon uses a left-handed view space by default, so visible perspective-space
  // splats are in front of the camera with positive view z.
  let centerView = modelView * vec4f(centerScale, 1.0);
  if (uniforms.projection[3][3] != 1.0 && centerView.z <= 0.0) {
    return vec4f(0.0, 0.0, 2.0, 1.0);
  }
  let centerClipClamped = vec4f(centerClip.xy, clamp(centerClip.z, 0.0, abs(centerClip.w)), centerClip.w);

  // 3D rotation matrix
  let R = mat3x3f(
    vec3f(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y)),
    vec3f(2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x)),
    vec3f(2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y))
  );

  // Covariance in 3D: Vrk = M * M^T where M = R * S
  let M = mat3x3f(
    R[0] * scale.x,
    R[1] * scale.y,
    R[2] * scale.z
  );
  let Vrk = M * transpose(M);

  // Upper 3x3 of modelView
  let W = transpose(mat3x3f(modelView[0].xyz, modelView[1].xyz, modelView[2].xyz));

  // Focal length (scaled by viewport width to get pixel focal length)
  let focal = uniforms.viewport.x * projMat00;
  let v = centerView.xyz / centerView.w;

  // Jacobian J
  let J1 = focal / v.z;
  let J2 = -J1 / v.z * v.xy;
  let J = mat3x3f(
    vec3f(J1, 0.0, J2.x),
    vec3f(0.0, J1, J2.y),
    vec3f(0.0, 0.0, 0.0)
  );

  let T = W * J;
  let cov = transpose(T) * Vrk * T;

  // Add EWA lowpass reconstruction filter (0.3 pixel variance)
  let diagonal1 = cov[0][0] + 0.3;
  let offDiagonal = cov[0][1];
  let diagonal2 = cov[1][1] + 0.3;

  let mid = 0.5 * (diagonal1 + diagonal2);
  let radius = length(vec2f((diagonal1 - diagonal2) / 2.0, offDiagonal));
  let lambda1 = mid + radius;
  let lambda2 = max(mid - radius, 0.1);

  // Quad size scaling (using 2.0 * sqrt(2.0 * lambda) = sqrt(8 * lambda))
  let vmin = min(1024.0, min(uniforms.viewport.x, uniforms.viewport.y));
  let l1 = 2.0 * min(sqrt(2.0 * lambda1), vmin);
  let l2 = 2.0 * min(sqrt(2.0 * lambda2), vmin);

  // Check if splat is too small or outside view frustum
  let maxL = max(l1, l2);
  if (maxL < uniforms.minPixelRadius) {
    return vec4f(0.0, 0.0, 2.0, 1.0);
  }
  if (any(abs(centerClipClamped.xy) - vec2f(maxL, maxL) * centerClipClamped.w / uniforms.viewport > vec2f(centerClipClamped.w))) {
    return vec4f(0.0, 0.0, 2.0, 1.0);
  }

  let c = centerClipClamped.w / uniforms.viewport;
  let diagonalVector = normalize(vec2f(offDiagonal, lambda1 - diagonal1));
  let v1 = l1 * diagonalVector;
  let v2 = l2 * vec2f(diagonalVector.y, -diagonalVector.x);
  
  let offset = (corner.x * v1 + corner.y * v2) * c;
  return vec4f(centerClipClamped.xy + offset, centerClipClamped.zw);
}

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let sourceOrder = vertexInputs.instanceIndex * 128u + u32(vertexInputs.position.z);
  if (f32(sourceOrder) >= uniforms.renderSplatCount) {
    vertexOutputs.position = vec4f(0.0, 0.0, 2.0, 1.0);
    vertexOutputs.vCorner = vec2f(2.0, 2.0);
    vertexOutputs.vColor = vec4f(0.0);
    return vertexOutputs;
  }

  let corner = vertexInputs.position.xy;
  let splatIndex = indexBuffer[sourceOrder];
  let centerScale = centerScaleBuffer[splatIndex];
  let logScale = scaleBuffer[splatIndex];
  let rotation = normalize(rotationBuffer[splatIndex]);
  let splatColor = colorBuffer[splatIndex];
  let splatState = splatStateBuffer[splatIndex];
  if ((splatState & SPLAT_STATE_RENDER_DISABLED) != 0u) {
    vertexOutputs.position = vec4f(0.0, 0.0, 2.0, 1.0);
    vertexOutputs.vCorner = vec2f(2.0, 2.0);
    vertexOutputs.vColor = vec4f(0.0);
    return vertexOutputs;
  }
  let isSelected = (splatState & SPLAT_STATE_SELECTED) != 0u;
  let centerClip = uniforms.worldViewProjection * vec4f(centerScale.xyz, 1.0);

  if (uniforms.vizMode >= 1.0) {
    let pixelRadius = 2.0;
    let clipOffset = corner * pixelRadius * 2.0 / uniforms.viewport * centerClip.w;
    vertexOutputs.position = vec4f(centerClip.xy + clipOffset, centerClip.zw);
    vertexOutputs.vCorner = corner;
    if (uniforms.vizMode == 2.0) {
      let chunkId = f32(splatIndex / CHUNK_SIZE);
      let rng = vec3f(
        fract(sin(chunkId * 12.9898 + 1.0) * 43758.5453),
        fract(sin(chunkId * 78.233 + 2.0) * 43758.5453),
        fract(sin(chunkId * 45.164 + 3.0) * 43758.5453),
      );
      vertexOutputs.vColor = vec4f(rng, 1.0);
    } else if (uniforms.vizMode == 3.0) {
      let groupId = f32(colorGroupBuffer[splatIndex]);
      let palette = vec3f(
        fract(sin(groupId * 12.9898 + 1.0) * 43758.5453),
        fract(sin(groupId * 78.233 + 2.0) * 43758.5453),
        fract(sin(groupId * 45.164 + 3.0) * 43758.5453),
      );
      vertexOutputs.vColor = vec4f(palette, 1.0);
    } else {
      vertexOutputs.vColor = splatColor;
    }
    if (isSelected) {
      vertexOutputs.vColor = vec4f(mix(vertexOutputs.vColor.rgb, vec3f(0.3, 1.0, 0.4), 0.85), 1.0);
    }
    return vertexOutputs;
  }
  
  let modelView = uniforms.view * uniforms.world;
  
  let pos = initCornerCov(
    centerScale.xyz, 
    rotation, 
    exp(logScale.xyz) * uniforms.gaussianScale, 
    corner, 
    centerClip,
    uniforms.projection[0][0],
    modelView
  );

  vertexOutputs.position = pos;
  vertexOutputs.vCorner = corner;
  vertexOutputs.vColor = select(splatColor, vec4f(mix(splatColor.rgb, vec3f(0.3, 1.0, 0.4), 0.8), 1.0), isSelected);
}
