import { Plane } from "@babylonjs/core/Maths/math.plane";

import type { SsogBound } from "./SplatAsset";

const isAabbInFrustum = (bound: SsogBound, planes: Plane[], margin: number): boolean => {
  for (const plane of planes) {
    const n = plane.normal;
    const px = n.x >= 0 ? bound.max[0] : bound.min[0];
    const py = n.y >= 0 ? bound.max[1] : bound.min[1];
    const pz = n.z >= 0 ? bound.max[2] : bound.min[2];

    if (n.x * px + n.y * py + n.z * pz + plane.d < -margin) {
      return false;
    }
  }

  return true;
};

export { isAabbInFrustum };
