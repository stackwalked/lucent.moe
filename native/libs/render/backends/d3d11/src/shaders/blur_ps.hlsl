// One axis of a separable Gaussian. Each tap after the centre sits between two texels at their
// weighted midpoint, so the bilinear sampler adds the pair: a kernel reaching n texels takes about
// n / 2 samples a side. The weights are computed here from the deviation, so no array crosses
// from C++.

#include "interface.hlsli"

float4 tap(float2 uv) {
    return source.SampleLevel(linear_clamp, clamp(uv, passing.limit.xy, passing.limit.zw), 0.0f);
}

float gaussian(float offset, float sigma) {
    return exp(-(offset * offset) / (2.0f * sigma * sigma));
}

float4 main(pixel_input input) : SV_Target {
    float2 uv = input.pixel * passing.mapping.xy + passing.mapping.zw;
    float2 step = passing.filter.xy;
    float sigma = max(passing.filter.z, 1e-3f);
    uint reach = min((uint)passing.filter.w, max_blur_radius);

    float4 sum = tap(uv);
    float total = 1.0f;
    [loop]
    for (uint i = 1; i <= reach; i += 2) {
        float first = gaussian((float)i, sigma);
        float second = i + 1 <= reach ? gaussian((float)(i + 1), sigma) : 0.0f;
        float weight = first + second;
        float offset = ((float)i * first + (float)(i + 1) * second) / max(weight, 1e-12f);
        sum += (tap(uv + step * offset) + tap(uv - step * offset)) * weight;
        total += 2.0f * weight;
    }
    return sum / total;
}
