/* Effect-gate transport ABI. There is deliberately no shim yet, and the native
   driver refuses every EFFECT before it selects a compiler. A future shim
   receives canonical UTF-8 JSON and returns canonical UTF-8 JSON; its C return
   code describes transport only, never whether an effect happened. */
extern int alcor_gate_effect_v1(const uint8_t *request_json, size_t request_len,
                                uint8_t *result_json, size_t result_capacity,
                                size_t *result_len);
