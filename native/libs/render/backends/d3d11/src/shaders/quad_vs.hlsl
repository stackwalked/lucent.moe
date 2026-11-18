// One record per instance, its four corners from SV_VertexID as a triangle strip.

#include "interface.hlsli"

struct quad_input {
    // From a per-instance buffer holding 0, 1, 2, ...: an instanced attribute is offset by the
    // draw's StartInstanceLocation, which SV_InstanceID ignores, so a run starting at record n
    // reads n here.
    uint record : RECORD;
    uint corner : SV_VertexID;
};

pixel_input main(quad_input input) {
    quad_record shape = records[input.record];
    float softness = f16tof32(shape.style.w & 0xffff);
    float grow = reach_sigmas * softness + reach_pixels;
    float2 at = float2(input.corner & 1, input.corner >> 1);
    float2 corner = lerp(shape.rect.xy - grow, shape.rect.zw + grow, at);

    pixel_input output;
    output.position = clip_position(corner, frame.target.xy);
    output.pixel = corner;
    output.color = float4(0.0f, 0.0f, 0.0f, 0.0f);
    output.record = input.record;
    return output;
}
