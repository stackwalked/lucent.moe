// A pass's rect from its constants, as a triangle strip: blur steps, downsamples, composites and
// the light probe all cover one rect and need no vertex buffer.

#include "interface.hlsli"

pixel_input main(uint corner : SV_VertexID) {
    float2 at = float2(corner & 1, corner >> 1);
    float2 position = lerp(passing.rect.xy, passing.rect.zw, at);

    pixel_input output;
    output.position = clip_position(position, passing.space.xy);
    output.pixel = position;
    output.color = float4(0.0f, 0.0f, 0.0f, 0.0f);
    output.record = path_record;
    return output;
}
