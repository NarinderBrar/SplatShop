@group(0) @binding(0) var<storage, read> bucketCounts: array<u32>;
@group(0) @binding(1) var<storage, read_write> bucketOffsets: array<u32>;
@group(0) @binding(2) var<storage, read> paramsBuffer: array<u32>;

var<workgroup> scanValues: array<u32, __PREFIX_SUM_SOURCE_EXPR_0__>;
var<workgroup> nextValues: array<u32, __PREFIX_SUM_SOURCE_EXPR_1__>;

@compute @workgroup_size(__PREFIX_SUM_SOURCE_EXPR_2__)
fn main(@builtin(local_invocation_id) localId: vec3u) {
  let threadIndex = localId.x;
  let bucketCount = paramsBuffer[0];

  var index = threadIndex;
  loop {
    if (index >= bucketCount) {
      break;
    }
    scanValues[index] = bucketCounts[index];
    index = index + __PREFIX_SUM_SOURCE_EXPR_3__u;
  }
  workgroupBarrier();

  var offset = 1u;
  loop {
    if (offset >= bucketCount) {
      break;
    }

    index = threadIndex;
    loop {
      if (index >= bucketCount) {
        break;
      }

      var value = scanValues[index];
      if (index >= offset) {
        value = value + scanValues[index - offset];
      }
      nextValues[index] = value;
      index = index + __PREFIX_SUM_SOURCE_EXPR_4__u;
    }
    workgroupBarrier();

    index = threadIndex;
    loop {
      if (index >= bucketCount) {
        break;
      }
      scanValues[index] = nextValues[index];
      index = index + __PREFIX_SUM_SOURCE_EXPR_5__u;
    }
    workgroupBarrier();

    offset = offset << 1u;
  }

  index = threadIndex;
  loop {
    if (index >= bucketCount) {
      break;
    }
    if (index == 0u) {
      bucketOffsets[index] = 0u;
    } else {
      bucketOffsets[index] = scanValues[index - 1u];
    }
    index = index + __PREFIX_SUM_SOURCE_EXPR_6__u;
  }
}
