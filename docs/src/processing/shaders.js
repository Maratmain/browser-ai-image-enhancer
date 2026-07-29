export const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;
export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_image;
uniform float u_exposure;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_pivot;
in vec2 v_uv;
out vec4 outColor;

vec3 srgbToLinear(vec3 value) {
  vec3 low = value / 12.92;
  vec3 high = pow((value + 0.055) / 1.055, vec3(2.4));
  return mix(high, low, lessThanEqual(value, vec3(0.04045)));
}

vec3 linearToSrgb(vec3 value) {
  value = clamp(value, 0.0, 1.0);
  vec3 low = value * 12.92;
  vec3 high = 1.055 * pow(value, vec3(1.0 / 2.4)) - 0.055;
  return mix(high, low, lessThanEqual(value, vec3(0.0031308)));
}

void main() {
  vec4 pixel = texture(u_image, vec2(v_uv.x, 1.0 - v_uv.y));
  vec3 linear = srgbToLinear(pixel.rgb);
  linear *= exp2(u_exposure);
  linear = (linear - vec3(u_pivot)) * u_contrast + vec3(u_pivot);
  float luminance = dot(linear, vec3(0.2126, 0.7152, 0.0722));
  linear = vec3(luminance) + u_saturation * (linear - vec3(luminance));
  outColor = vec4(linearToSrgb(linear), pixel.a);
}`;
