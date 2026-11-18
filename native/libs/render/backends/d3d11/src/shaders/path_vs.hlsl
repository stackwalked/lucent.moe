// Tessellated path triangles: position and colour, nothing to look up.

#include "interface.hlsli"

struct path_input {
    float2 position : POSITION;
    float4 color : COLOR;
};

pixel_input main(path_input input) {
    pixel_input output;
    output.position = clip_position(input.position, frame.target.xy);
    output.pixel = input.position;
    output.color = input.color;
    output.record = path_record;
    return output;
}
