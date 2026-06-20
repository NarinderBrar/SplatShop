fn chan(pixel: u32, component: u32) -> u32 {
  return (pixel >> (component * 8u)) & 255u;
}

fn chanf(pixel: u32, component: u32) -> f32 {
  return f32(chan(pixel, component));
}
