const INVALID_BEHIND: i32 = -1;
const INVALID_CLIPPED: i32 = -2;
const SQRT2: f32 = 1.4142135623730951;
const EXP4: f32 = 0.01831563888873418;
const ONE_MINUS_EXP4: f32 = 0.9816843611112658;

fn chan(pixel: u32, component: u32) -> u32 {
  return (pixel >> (component * 8u)) & 255u;
}

fn transformCenter(center: vec3f) -> vec4f {
  return vec4f(
    paramsBuffer[0] * center.x + paramsBuffer[4] * center.y + paramsBuffer[8] * center.z + paramsBuffer[12],
    paramsBuffer[1] * center.x + paramsBuffer[5] * center.y + paramsBuffer[9] * center.z + paramsBuffer[13],
    paramsBuffer[2] * center.x + paramsBuffer[6] * center.y + paramsBuffer[10] * center.z + paramsBuffer[14],
    paramsBuffer[3] * center.x + paramsBuffer[7] * center.y + paramsBuffer[11] * center.z + paramsBuffer[15]
  );
}

fn packedSourceIndex(ordinal: u32) -> u32 {
  let entry = ordinalToPackedBuffer[ordinal];
  let chunk = entry >> 24u;
  let local = entry & 16777215u;
  return u32(chunkInfoBuffer[chunk * 2u].w) + local;
}

fn decodeRotation(ordinal: u32) -> vec4f {
  let pixel = quatsBuffer[packedSourceIndex(ordinal)];
  let a = (f32(chan(pixel, 0u)) / 255.0 - 0.5) * SQRT2;
  let b = (f32(chan(pixel, 1u)) / 255.0 - 0.5) * SQRT2;
  let c = (f32(chan(pixel, 2u)) / 255.0 - 0.5) * SQRT2;
  let d = sqrt(max(0.0, 1.0 - (a * a + b * b + c * c)));
  let mode = chan(pixel, 3u) - 252u;
  if (mode == 0u) { return vec4f(d, a, b, c); }
  if (mode == 1u) { return vec4f(a, d, b, c); }
  if (mode == 2u) { return vec4f(a, b, d, c); }
  return vec4f(a, b, c, d);
}

fn decodeScale(ordinal: u32) -> vec3f {
  let entry = ordinalToPackedBuffer[ordinal];
  let chunk = entry >> 24u;
  let index = packedSourceIndex(ordinal);
  let codebookOffset = u32(chunkInfoBuffer[chunk * 2u + 1u].w);
  let pixel = scalesBuffer[index];
  return exp(vec3f(
    scaleCodebookBuffer[codebookOffset + chan(pixel, 0u)],
    scaleCodebookBuffer[codebookOffset + chan(pixel, 1u)],
    scaleCodebookBuffer[codebookOffset + chan(pixel, 2u)]
  ));
}

fn screenDerivative(clip: vec4f, column: vec4f, viewport: vec2f) -> vec2f {
  let invW2 = 1.0 / max(0.000000000001, clip.w * clip.w);
  return vec2f(
    (column.x * clip.w - clip.x * column.w) * invW2 * viewport.x * 0.5,
    -(column.y * clip.w - clip.y * column.w) * invW2 * viewport.y * 0.5
  );
}

// Returns inclusive tile bounds. Negative x encodes the rejection reason.
fn snugBoxTileBounds(index: u32) -> vec4i {
  let centerOffset = u32(paramsBuffer[24]);
  let center = centerBuffer[centerOffset + index].xyz;
  let clip = transformCenter(center);
  if (clip.w <= 0.000001) {
    return vec4i(INVALID_BEHIND);
  }

  let alphaClip = max(0.0000001, paramsBuffer[26]);
  let opacity = clamp(colorBuffer[packedSourceIndex(index)].a, 0.0, 1.0);
  if (opacity <= alphaClip) {
    return vec4i(INVALID_CLIPPED);
  }

  let viewport = vec2f(paramsBuffer[16], paramsBuffer[17]);
  let dX = screenDerivative(
    clip,
    vec4f(paramsBuffer[0], paramsBuffer[1], paramsBuffer[2], paramsBuffer[3]),
    viewport
  );
  let dY = screenDerivative(
    clip,
    vec4f(paramsBuffer[4], paramsBuffer[5], paramsBuffer[6], paramsBuffer[7]),
    viewport
  );
  let dZ = screenDerivative(
    clip,
    vec4f(paramsBuffer[8], paramsBuffer[9], paramsBuffer[10], paramsBuffer[11]),
    viewport
  );

  let q = normalize(decodeRotation(index));
  let w = q.x;
  let x = q.y;
  let y = q.z;
  let z = q.w;
  let rotation = mat3x3f(
    vec3f(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y)),
    vec3f(2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x)),
    vec3f(2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y))
  );
  let scale = decodeScale(index);
  let axis0 = rotation[0] * scale.x;
  let axis1 = rotation[1] * scale.y;
  let axis2 = rotation[2] * scale.z;
  let projected0 = dX * axis0.x + dY * axis0.y + dZ * axis0.z;
  let projected1 = dX * axis1.x + dY * axis1.y + dZ * axis1.z;
  let projected2 = dX * axis2.x + dY * axis2.y + dZ * axis2.z;

  let lowpass = max(0.0, paramsBuffer[27]);
  let diagonal1 =
    dot(vec3f(projected0.x, projected1.x, projected2.x), vec3f(projected0.x, projected1.x, projected2.x)) +
    lowpass;
  let offDiagonal =
    dot(vec3f(projected0.x, projected1.x, projected2.x), vec3f(projected0.y, projected1.y, projected2.y));
  let diagonal2 =
    dot(vec3f(projected0.y, projected1.y, projected2.y), vec3f(projected0.y, projected1.y, projected2.y)) +
    lowpass;

  let midpoint = 0.5 * (diagonal1 + diagonal2);
  let eigenRadius = length(vec2f((diagonal1 - diagonal2) * 0.5, offDiagonal));
  let lambda1 = max(0.0, midpoint + eigenRadius);
  let lambda2 = max(0.1, midpoint - eigenRadius);
  let maxStdDev = max(0.5, paramsBuffer[28]);
  let maxPixelRadius = max(1.0, paramsBuffer[29]);
  let extent1 = min(maxStdDev * sqrt(lambda1), maxPixelRadius);
  let extent2 = min(maxStdDev * sqrt(lambda2), maxPixelRadius);
  if (max(extent1, extent2) < max(0.0, paramsBuffer[30])) {
    return vec4i(INVALID_CLIPPED);
  }

  var eigenAxis = vec2f(1.0, 0.0);
  let rawAxis = vec2f(offDiagonal, lambda1 - diagonal1);
  if (dot(rawAxis, rawAxis) > 0.00000001) {
    eigenAxis = normalize(rawAxis);
  }
  let axisExtent1 = extent1 * eigenAxis;
  let axisExtent2 = extent2 * vec2f(eigenAxis.y, -eigenAxis.x);

  // Match normExp() in the splat fragment shader instead of assuming an
  // unbounded exp(-0.5 * r^2) Gaussian.
  let normalizedCutoff = clamp(alphaClip / opacity, 0.0, 1.0);
  let expAtCutoff = EXP4 + normalizedCutoff * ONE_MINUS_EXP4;
  let blur = max(0.5, paramsBuffer[31]);
  let supportScale = min(1.0, blur * sqrt(max(0.0, -0.25 * log(max(EXP4, expAtCutoff)))));
  let halfExtent = supportScale * vec2f(
    length(vec2f(axisExtent1.x, axisExtent2.x)),
    length(vec2f(axisExtent1.y, axisExtent2.y))
  );

  let ndc = clip.xy / clip.w;
  let centerPixel = (ndc * vec2f(0.5, -0.5) + vec2f(0.5)) * viewport;
  let minPixel = centerPixel - halfExtent;
  let maxPixel = centerPixel + halfExtent;
  if (maxPixel.x < 0.0 || maxPixel.y < 0.0 || minPixel.x >= viewport.x || minPixel.y >= viewport.y) {
    return vec4i(INVALID_CLIPPED);
  }

  let tileSize = paramsBuffer[18];
  let tileCols = u32(paramsBuffer[19]);
  let tileRows = u32(paramsBuffer[20]);
  let minTile = vec2u(clamp(floor(max(minPixel, vec2f(0.0)) / tileSize), vec2f(0.0), vec2f(f32(tileCols - 1u), f32(tileRows - 1u))));
  let maxTile = vec2u(clamp(floor(min(maxPixel, viewport - vec2f(0.0001)) / tileSize), vec2f(0.0), vec2f(f32(tileCols - 1u), f32(tileRows - 1u))));
  return vec4i(i32(minTile.x), i32(minTile.y), i32(maxTile.x), i32(maxTile.y));
}
