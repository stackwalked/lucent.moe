// One bilinear tap where four source texels meet: a 2x2 box, halving the surface. The light probe
// uses it too, to take a blurred backdrop down to a few texels.

#include "interface.hlsli"

float4 main(pixel_input input) : SV_Target {
    float2 uv = input.pixel * passing.mapping.xy + passing.mapping.zw;
    return source.SampleLevel(linear_clamp, clamp(uv, passing.limit.xy, passing.limit.zw), 0.0f);
}
