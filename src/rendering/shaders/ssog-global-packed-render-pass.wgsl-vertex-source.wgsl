attribute position: vec3f;

uniform worldViewProjection: mat4x4f;
uniform view: mat4x4f;
uniform world: mat4x4f;
uniform projection: mat4x4f;
uniform viewport: vec2f;
uniform minPixelRadius: f32;
uniform maxPixelRadius: f32;
uniform maxStdDev: f32;
uniform clipXY: f32;
uniform preBlurAmount: f32;
uniform renderSplatCount: f32;
uniform vizMode: f32;

var<storage, read> meansLBuffer: array<u32>;
var<storage, read> meansUBuffer: array<u32>;
var<storage, read> quatsBuffer: array<u32>;
var<storage, read> scalesBuffer: array<u32>;
var<storage, read> colorBuffer: array<vec4f>;
var<storage, read> colorGroupBuffer: array<u32>;
var<storage, read> splatStateBuffer: array<u32>;
var<storage, read> scaleCodebookBuffer: array<f32>;
var<storage, read> chunkInfoBuffer: array<vec4f>;
var<storage, read> chunkDebugColorBuffer: array<vec4f>;
var<storage, read> indexBuffer: array<u32>;

varying vCorner: vec2f;
varying vColor: vec4f;

#define CUSTOM_VERTEX_DEFINITIONS

const SQRT2: f32 = 1.4142135623730951;
const SPLAT_STATE_SELECTED: u32 = 1u;
const SPLAT_STATE_RENDER_DISABLED: u32 = 26u;

fn chan(pixel: u32, component: u32) -> u32 {
  return (pixel >> (component * 8u)) & 255u;
}

fn chanf(pixel: u32, component: u32) -> f32 {
  return f32(chan(pixel, component));
}

fn chunkIndex(packedIndex: u32) -> u32 {
  return packedIndex >> 24u;
}

fn localIndex(packedIndex: u32) -> u32 {
  return packedIndex & 16777215u;
}

fn sourceIndex(packedIndex: u32) -> u32 {
  let chunk = chunkIndex(packedIndex);
  return u32(chunkInfoBuffer[chunk * 2u].w) + localIndex(packedIndex);
}

fn decodeCenter(packedIndex: u32) -> vec3f {
  let chunk = chunkIndex(packedIndex);
  let index = sourceIndex(packedIndex);
  let meansMin = chunkInfoBuffer[chunk * 2u].xyz;
  let meansMaxAndScaleOffset = chunkInfoBuffer[chunk * 2u + 1u];
  let meansMax = meansMaxAndScaleOffset.xyz;
  let lo = meansLBuffer[index];
  let hi = meansUBuffer[index];
  let q = vec3f(
    f32((chan(hi, 0u) << 8u) + chan(lo, 0u)) / 65535.0,
    f32((chan(hi, 1u) << 8u) + chan(lo, 1u)) / 65535.0,
    f32((chan(hi, 2u) << 8u) + chan(lo, 2u)) / 65535.0
  );
  let encoded = meansMin * (vec3f(1.0) - q) + meansMax * q;
  return sign(encoded) * (exp(abs(encoded)) - vec3f(1.0));
}

fn decodeRotation(packedIndex: u32) -> vec4f {
  let index = sourceIndex(packedIndex);
  let pixel = quatsBuffer[index];
  let a = (chanf(pixel, 0u) / 255.0 - 0.5) * SQRT2;
  let b = (chanf(pixel, 1u) / 255.0 - 0.5) * SQRT2;
  let c = (chanf(pixel, 2u) / 255.0 - 0.5) * SQRT2;
  let d = sqrt(max(0.0, 1.0 - (a * a + b * b + c * c)));
  let mode = chan(pixel, 3u) - 252u;
  if (mode == 0u) {
    return vec4f(d, a, b, c);
  }
  if (mode == 1u) {
    return vec4f(a, d, b, c);
  }
  if (mode == 2u) {
    return vec4f(a, b, d, c);
  }
  return vec4f(a, b, c, d);
}

fn decodeScale(packedIndex: u32) -> vec3f {
  let chunk = chunkIndex(packedIndex);
  let index = sourceIndex(packedIndex);
  let scaleCodebookOffset = u32(chunkInfoBuffer[chunk * 2u + 1u].w);
  let pixel = scalesBuffer[index];
  return vec3f(
    scaleCodebookBuffer[scaleCodebookOffset + chan(pixel, 0u)],
    scaleCodebookBuffer[scaleCodebookOffset + chan(pixel, 1u)],
    scaleCodebookBuffer[scaleCodebookOffset + chan(pixel, 2u)]
  );
}

fn initCornerCov(center: vec3f, rotation: vec4f, scale: vec3f, corner: vec2f, centerClip: vec4f) -> vec4f {
  let w = rotation.x;
  let x = rotation.y;
  let y = rotation.z;
  let z = rotation.w;
  let modelView = uniforms.view * uniforms.world;
  let centerView = modelView * vec4f(center, 1.0);
  if (uniforms.projection[3][3] != 1.0 && centerView.z <= 0.0) {
    return vec4f(0.0, 0.0, 2.0, 1.0);
  }
  let centerClipClamped = vec4f(centerClip.xy, clamp(centerClip.z, 0.0, abs(centerClip.w)), centerClip.w);

  let R = mat3x3f(
    vec3f(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y)),
    vec3f(2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x)),
    vec3f(2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y))
  );
  let M = mat3x3f(R[0] * scale.x, R[1] * scale.y, R[2] * scale.z);
  let Vrk = M * transpose(M);
  let W = transpose(mat3x3f(modelView[0].xyz, modelView[1].xyz, modelView[2].xyz));
  let focal = uniforms.viewport.x * uniforms.projection[0][0];
  let v = centerView.xyz / centerView.w;
  let J1 = focal / v.z;
  let J2 = -J1 / v.z * v.xy;
  let J = mat3x3f(vec3f(J1, 0.0, J2.x), vec3f(0.0, J1, J2.y), vec3f(0.0, 0.0, 0.0));
  let T = W * J;
  let cov = transpose(T) * Vrk * T;
  let lowpass = max(0.0, uniforms.preBlurAmount);
  let diagonal1 = cov[0][0] + lowpass;
  let offDiagonal = cov[0][1];
  let diagonal2 = cov[1][1] + lowpass;
  let mid = 0.5 * (diagonal1 + diagonal2);
  let radius = length(vec2f((diagonal1 - diagonal2) / 2.0, offDiagonal));
  let lambda1 = mid + radius;
  let lambda2 = max(mid - radius, 0.1);
  let vmin = min(1024.0, min(uniforms.viewport.x, uniforms.viewport.y));
  let stdDev = max(0.5, uniforms.maxStdDev);
  let l1 = min(stdDev * sqrt(lambda1), min(uniforms.maxPixelRadius, vmin));
  let l2 = min(stdDev * sqrt(lambda2), min(uniforms.maxPixelRadius, vmin));
  let maxL = max(l1, l2);
  if (maxL < uniforms.minPixelRadius) {
    return vec4f(0.0, 0.0, 2.0, 1.0);
  }
  if (any(abs(centerClipClamped.xy) - vec2f(maxL, maxL) * centerClipClamped.w / uniforms.viewport > vec2f(centerClipClamped.w * uniforms.clipXY))) {
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
  let packedSplatIndex = indexBuffer[sourceOrder];
  let splatIndex = sourceIndex(packedSplatIndex);
  let splatState = splatStateBuffer[splatIndex];
  if ((splatState & SPLAT_STATE_RENDER_DISABLED) != 0u) {
    vertexOutputs.position = vec4f(0.0, 0.0, 2.0, 1.0);
    vertexOutputs.vCorner = vec2f(2.0, 2.0);
    vertexOutputs.vColor = vec4f(0.0);
    return vertexOutputs;
  }
  let isSelected = (splatState & SPLAT_STATE_SELECTED) != 0u;
  let center = decodeCenter(packedSplatIndex);
  let rotation = normalize(decodeRotation(packedSplatIndex));
  let logScale = decodeScale(packedSplatIndex);
  let centerClip = uniforms.worldViewProjection * vec4f(center, 1.0);

  if (uniforms.vizMode >= 1.0) {
    let pixelRadius = 2.0;
    let clipOffset = corner * pixelRadius * 2.0 / uniforms.viewport * centerClip.w;
    vertexOutputs.position = vec4f(centerClip.xy + clipOffset, centerClip.zw);
    vertexOutputs.vCorner = corner;
    if (uniforms.vizMode == 2.0) {
      vertexOutputs.vColor = chunkDebugColorBuffer[chunkIndex(packedSplatIndex)];
    } else if (uniforms.vizMode == 3.0) {
      let groupId = f32(colorGroupBuffer[splatIndex]);
      let palette = vec3f(
        fract(sin(groupId * 12.9898 + 1.0) * 43758.5453),
        fract(sin(groupId * 78.233 + 2.0) * 43758.5453),
        fract(sin(groupId * 45.164 + 3.0) * 43758.5453),
      );
      vertexOutputs.vColor = vec4f(palette, 1.0);
    } else {
      vertexOutputs.vColor = colorBuffer[splatIndex];
    }
    if (isSelected) {
      vertexOutputs.vColor = vec4f(mix(vertexOutputs.vColor.rgb, vec3f(0.3, 1.0, 0.4), 0.85), 1.0);
    }
    return vertexOutputs;
  }

  vertexOutputs.position = initCornerCov(center, rotation, exp(logScale), corner, centerClip);
  vertexOutputs.vCorner = corner;
  vertexOutputs.vColor = colorBuffer[splatIndex];
  if (isSelected) {
    vertexOutputs.vColor = vec4f(mix(vertexOutputs.vColor.rgb, vec3f(0.3, 1.0, 0.4), 0.85), 1.0);
  }
}
