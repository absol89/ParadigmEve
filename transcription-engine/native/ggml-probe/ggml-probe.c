// ggml-probe: report which ggml compute devices are compiled into this whisper.cpp build and
// prove each GPU device is usable by running a small matrix multiply on it and checking the
// result against the exact answer. Prints one JSON object to stdout. No model is needed.
//
// Exit code 0 always when the probe itself ran; usability is in the JSON.

#include "ggml.h"
#include "ggml-alloc.h"
#include "ggml-backend.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

static void json_string(const char * s) {
    putchar('"');
    for (; s && *s; ++s) {
        unsigned char c = (unsigned char) *s;
        if (c == '"' || c == '\\') { putchar('\\'); putchar(c); }
        else if (c < 0x20) printf("\\u%04x", c);
        else putchar(c);
    }
    putchar('"');
}

// Multiply a 32x32 matrix by a 32x8 matrix of small integers on the device and compare exactly.
static const char * compute_check(ggml_backend_dev_t dev) {
    ggml_backend_t backend = ggml_backend_dev_init(dev, NULL);
    if (!backend) return "backend init failed";

    struct ggml_init_params params = { 16 * ggml_tensor_overhead() + ggml_graph_overhead(), NULL, true };
    struct ggml_context * ctx = ggml_init(params);
    const int K = 32, M = 32, N = 8;
    struct ggml_tensor * a = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, K, M);
    struct ggml_tensor * b = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, K, N);
    struct ggml_tensor * c = ggml_mul_mat(ctx, a, b);
    struct ggml_cgraph * graph = ggml_new_graph(ctx);
    ggml_build_forward_expand(graph, c);

    ggml_backend_buffer_t buffer = ggml_backend_alloc_ctx_tensors(ctx, backend);
    const char * error = NULL;
    if (!buffer) {
        error = "device buffer allocation failed";
    } else {
        static float av[32 * 32], bv[32 * 8], cv[32 * 8];
        for (int i = 0; i < K * M; ++i) av[i] = (float) ((i * 7) % 5 - 2);
        for (int i = 0; i < K * N; ++i) bv[i] = (float) ((i * 3) % 7 - 3);
        ggml_backend_tensor_set(a, av, 0, sizeof(av));
        ggml_backend_tensor_set(b, bv, 0, sizeof(bv));
        if (ggml_backend_graph_compute(backend, graph) != GGML_STATUS_SUCCESS) {
            error = "graph compute failed";
        } else {
            ggml_backend_tensor_get(c, cv, 0, sizeof(cv));
            for (int n = 0; n < N && !error; ++n) {
                for (int m = 0; m < M; ++m) {
                    float expected = 0.0f;
                    for (int k = 0; k < K; ++k) expected += av[m * K + k] * bv[n * K + k];
                    if (fabsf(cv[n * M + m] - expected) > 1e-2f) { error = "wrong result"; break; }
                }
            }
        }
        ggml_backend_buffer_free(buffer);
    }
    ggml_free(ctx);
    ggml_backend_free(backend);
    return error;
}

int main(void) {
    const size_t count = ggml_backend_dev_count();
    printf("{\"probe\":\"ggml-probe/1\",\"backends\":[");
    for (size_t i = 0; i < ggml_backend_reg_count(); ++i) {
        if (i) putchar(',');
        json_string(ggml_backend_reg_name(ggml_backend_reg_get(i)));
    }
    printf("],\"devices\":[");
    int gpu_index = 0;
    for (size_t i = 0; i < count; ++i) {
        ggml_backend_dev_t dev = ggml_backend_dev_get(i);
        enum ggml_backend_dev_type type = ggml_backend_dev_type(dev);
        size_t free_mem = 0, total_mem = 0;
        ggml_backend_dev_memory(dev, &free_mem, &total_mem);
        const char * kind = type == GGML_BACKEND_DEVICE_TYPE_GPU ? "gpu"
                          : type == GGML_BACKEND_DEVICE_TYPE_CPU ? "cpu" : "other";
        if (i) putchar(',');
        printf("{\"name\":");
        json_string(ggml_backend_dev_name(dev));
        printf(",\"description\":");
        json_string(ggml_backend_dev_description(dev));
        printf(",\"backend\":");
        json_string(ggml_backend_reg_name(ggml_backend_dev_backend_reg(dev)));
        printf(",\"type\":\"%s\",\"memory_total\":%zu,\"memory_free\":%zu", kind, total_mem, free_mem);
        if (type == GGML_BACKEND_DEVICE_TYPE_GPU) {
            // whisper-cli's --device N counts GPU devices only, in this order.
            const char * error = compute_check(dev);
            printf(",\"gpu_index\":%d,\"usable\":%s,\"error\":", gpu_index++, error ? "false" : "true");
            if (error) json_string(error); else printf("null");
        }
        putchar('}');
    }
    printf("]}\n");
    return 0;
}
