#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

typedef struct { int tag; long long i; const char *s; long long n; } Val;
/* tag: 0 = int, 1 = str, 2 = bool */

char **alc_tape = NULL;
long long *alc_tape_len = NULL;
long alc_tape_n = 0, alc_tape_cap = 0;
char **alc_lines = NULL;
long alc_lines_n = 0, alc_cursor = 0;
long long alc_steps = 0;
long alc_seq = 0;

Val alc_int(long long v) { Val r; r.tag = 0; r.i = v; r.s = NULL; r.n = 0; return r; }
Val alc_bool(int v) { Val r; r.tag = 2; r.i = v ? 1 : 0; r.s = NULL; r.n = 0; return r; }
Val alc_str(const char *s, long long n) { Val r; r.tag = 1; r.i = 0; r.s = s; r.n = n; return r; }

void alc_flush(void) {
    long k;
    for (k = 0; k < alc_tape_n; k++) {
        fwrite(alc_tape[k], 1, (size_t)alc_tape_len[k], stdout);
        fputc('\n', stdout);
    }
}

void alc_trap(const char *code) {
    alc_flush();
    printf("TRAP %s\n", code);
    fflush(stdout);
    exit(0);
}

Val alc_undef(void) { alc_trap("undefined_cell"); return alc_int(0); }
#define ALC_GET(fr, fld) ((fr)->d_##fld ? (fr)->fld : alc_undef())

void *alc_alloc(size_t n) {
    void *p = malloc(n);
    if (!p) { fputs("alcorlang: out of memory\n", stderr); exit(70); }
    return p;
}

char *alc_render(Val v) {
    char *buf;
    if (v.tag == 2) { buf = (char *)alc_alloc(6); strcpy(buf, v.i ? "true" : "false"); return buf; }
    if (v.tag == 0) { buf = (char *)alc_alloc(32); snprintf(buf, 32, "%lld", v.i); return buf; }
    buf = (char *)alc_alloc((size_t)v.n + 1);
    memcpy(buf, v.s, (size_t)v.n);
    buf[v.n] = 0;
    return buf;
}

int alc_truth(Val v) {
    if (v.tag == 2 || v.tag == 0) return v.i != 0;
    return v.n != 0;
}

void alc_emit(Val v) {
    char *rendered;
    long long rendered_len;
    if (alc_tape_n == alc_tape_cap) {
        alc_tape_cap = alc_tape_cap ? alc_tape_cap * 2 : 16;
        alc_tape = (char **)realloc(alc_tape, (size_t)alc_tape_cap * sizeof(char *));
        if (!alc_tape) { fputs("alcorlang: out of memory\n", stderr); exit(70); }
        alc_tape_len = (long long *)realloc(
            alc_tape_len, (size_t)alc_tape_cap * sizeof(long long));
        if (!alc_tape_len) { fputs("alcorlang: out of memory\n", stderr); exit(70); }
    }
    rendered = alc_render(v);
    rendered_len = v.tag == 1 ? v.n : (long long)strlen(rendered);
    alc_tape[alc_tape_n] = rendered;
    alc_tape_len[alc_tape_n] = rendered_len;
    alc_tape_n++;
}

Val alc_readline(void) {
    if (alc_cursor >= alc_lines_n) alc_trap("input_exhausted");
    { const char *s = alc_lines[alc_cursor++]; return alc_str(s, (long long)strlen(s)); }
}

void alc_step(long long fuel) {
    alc_steps++;
    if (fuel && alc_steps > fuel) alc_trap("fuel_exhausted");
}

int alc_sametype(Val a, Val b) { return a.tag == b.tag; }

int alc_streq(Val a, Val b) {
    if (a.n != b.n) return 0;
    return memcmp(a.s, b.s, (size_t)a.n) == 0;
}

int alc_strcmp(Val a, Val b) {
    long long m = a.n < b.n ? a.n : b.n;
    int c = m ? memcmp(a.s, b.s, (size_t)m) : 0;
    if (c) return c;
    return a.n < b.n ? -1 : (a.n > b.n ? 1 : 0);
}

/* UTF-8 helpers. A continuation byte is 10xxxxxx; every other byte starts a character. */
static long alc_char_len(const char *p) {
    unsigned char c = (unsigned char)*p;
    if (c < 0x80) return 1;
    if ((c & 0xE0) == 0xC0) return 2;
    if ((c & 0xF0) == 0xE0) return 3;
    if ((c & 0xF8) == 0xF0) return 4;
    return 1;                       /* a stray continuation byte counts as itself */
}

/* How many characters begin in s[0..n). Also: LEN. */
static long alc_char_index(const char *s, long n) {
    long i, count = 0;
    for (i = 0; i < n; i++)
        if (((unsigned char)s[i] & 0xC0) != 0x80) count++;
    return count;
}

/* Byte offset of character `want`, or -1 if it is off either end. */
static long alc_char_offset(const char *s, long n, long long want) {
    long i, count = 0;
    if (want < 0) return -1;
    for (i = 0; i < n; i++) {
        if (((unsigned char)s[i] & 0xC0) != 0x80) {
            if (count == want) return i;
            count++;
        }
    }
    return -1;
}

Val alc_bin(const char *op, Val a, Val b) {
    if (!strcmp(op, "ADD") || !strcmp(op, "SUB") || !strcmp(op, "MUL")
        || !strcmp(op, "DIV") || !strcmp(op, "MOD")) {
        long long r;
        if (a.tag != 0 || b.tag != 0) alc_trap("type_mismatch");
        /* §7: int64 on a bounded machine, so overflow traps instead of wrapping. */
        if (!strcmp(op, "ADD")) { if (__builtin_add_overflow(a.i, b.i, &r)) alc_trap("overflow"); return alc_int(r); }
        if (!strcmp(op, "SUB")) { if (__builtin_sub_overflow(a.i, b.i, &r)) alc_trap("overflow"); return alc_int(r); }
        if (!strcmp(op, "MUL")) { if (__builtin_mul_overflow(a.i, b.i, &r)) alc_trap("overflow"); return alc_int(r); }
        if (b.i == 0) alc_trap(!strcmp(op, "DIV") ? "div_zero" : "mod_zero");
        if (a.i == INT64_MIN && b.i == -1) alc_trap("overflow");
        r = a.i / b.i;
        if ((a.i % b.i != 0) && ((a.i < 0) != (b.i < 0))) r -= 1;   /* floor */
        if (!strcmp(op, "DIV")) return alc_int(r);
        return alc_int(a.i - r * b.i);                              /* divisor-signed */
    }
    if (!strcmp(op, "CAT")) {
        char *buf;
        if (a.tag != 1 || b.tag != 1) alc_trap("type_mismatch");
        buf = (char *)alc_alloc((size_t)(a.n + b.n) + 1);
        memcpy(buf, a.s, (size_t)a.n);
        memcpy(buf + a.n, b.s, (size_t)b.n);
        buf[a.n + b.n] = 0;
        return alc_str(buf, a.n + b.n);
    }
    if (!strcmp(op, "CHAR")) {
        /* §6.2 str is UTF-8, and the reference indexes CHARACTERS. Indexing bytes here
           would let CHAR return half a character -- invalid UTF-8 on the output tape,
           and a lexer that splits "é" into two tokens that are each not a character. */
        char *buf;
        long start, len;
        if (a.tag != 1 || b.tag != 0) alc_trap("type_mismatch");
        start = alc_char_offset(a.s, a.n, b.i);
        if (start < 0) return alc_str("", 0);
        len = alc_char_len(a.s + start);
        if (start + len > a.n) len = a.n - start;
        buf = (char *)alc_alloc((size_t)len + 1);
        memcpy(buf, a.s + start, (size_t)len);
        buf[len] = 0;
        return alc_str(buf, len);
    }
    if (!strcmp(op, "FIND")) {
        /* The byte match is found byte-wise -- that is what a substring IS -- but the
           index handed back is a CHARACTER index, so it can be fed straight to CHAR. */
        long i, j;
        if (a.tag != 1 || b.tag != 1) alc_trap("type_mismatch");
        if (b.n == 0) return alc_int(0);
        if (b.n > a.n) return alc_int(-1);
        for (i = 0; i + b.n <= a.n; i++) {
            for (j = 0; j < b.n && a.s[i + j] == b.s[j]; j++) { }
            if (j == b.n) return alc_int(alc_char_index(a.s, i));
        }
        return alc_int(-1);
    }
    if (!strcmp(op, "EQ") || !strcmp(op, "NE")) {
        int same = alc_sametype(a, b) && (a.tag == 1 ? alc_streq(a, b) : a.i == b.i);
        return alc_bool(!strcmp(op, "EQ") ? same : !same);
    }
    if (!strcmp(op, "LT") || !strcmp(op, "LE") || !strcmp(op, "GT") || !strcmp(op, "GE")) {
        int c;
        if (!((a.tag == 0 && b.tag == 0) || (a.tag == 1 && b.tag == 1)))
            alc_trap("type_mismatch");
        c = a.tag == 1 ? alc_strcmp(a, b) : (a.i < b.i ? -1 : (a.i > b.i ? 1 : 0));
        if (!strcmp(op, "LT")) return alc_bool(c < 0);
        if (!strcmp(op, "LE")) return alc_bool(c <= 0);
        if (!strcmp(op, "GT")) return alc_bool(c > 0);
        return alc_bool(c >= 0);
    }
    if (!strcmp(op, "AND")) return alc_bool(alc_truth(a) && alc_truth(b));
    if (!strcmp(op, "OR")) return alc_bool(alc_truth(a) || alc_truth(b));
    alc_trap("type_mismatch");
    return alc_int(0);
}

Val alc_un(const char *op, Val a) {
    if (!strcmp(op, "NEG")) {
        if (a.tag != 0) alc_trap("type_mismatch");
        if (a.i == INT64_MIN) alc_trap("overflow");
        return alc_int(-a.i);
    }
    if (!strcmp(op, "LEN")) {
        /* Characters, not bytes. This one predates CHAR: `LEN "café"` was already 5 here
           and 4 in the reference, a silent divergence the all-ASCII corpus could not see.
           It has to agree with CHAR's index space or `i < LEN s` walks off the end. */
        if (a.tag != 1) alc_trap("type_mismatch");
        return alc_int(alc_char_index(a.s, a.n));
    }
    if (!strcmp(op, "STR")) {
        char *buf = alc_render(a);
        return alc_str(buf, (long long)strlen(buf));
    }
    if (!strcmp(op, "INT")) {
        long long v = 0; long long k; int neg = 0, digits = 0;
        if (a.tag == 2) return alc_int(a.i ? 1 : 0);
        if (a.tag == 0) return a;
        for (k = 0; k < a.n; k++) {
            char c = a.s[k];
            if (k == 0 && c == '-') { neg = 1; continue; }
            if (c < '0' || c > '9') alc_trap("bad_int");
            if (__builtin_mul_overflow(v, (long long)10, &v)) alc_trap("overflow");
            if (__builtin_add_overflow(v, (long long)(c - '0'), &v)) alc_trap("overflow");
            digits = 1;
        }
        if (!digits) alc_trap("bad_int");
        return alc_int(neg ? -v : v);
    }
    if (!strcmp(op, "NOT")) return alc_bool(!alc_truth(a));
    alc_trap("type_mismatch");
    return alc_int(0);
}

void alc_read_stdin(void) {
    size_t cap = 4096, len = 0;
    char *buf = (char *)alc_alloc(cap);
    size_t got;
    long cap_l = 0;
    size_t start = 0, k;
    while ((got = fread(buf + len, 1, cap - len, stdin)) > 0) {
        len += got;
        if (len == cap) {
            cap *= 2;
            buf = (char *)realloc(buf, cap);
            if (!buf) { fputs("alcorlang: out of memory\n", stderr); exit(70); }
        }
    }
    buf[len] = 0;
    for (k = 0; k <= len; k++) {
        if (k == len || buf[k] == '\n') {
            size_t end = k;
            if (k == len && start == k) break;      /* matches str.splitlines() */
            if (k < len && end > start && buf[end - 1] == '\r') end--;
            if (alc_lines_n == cap_l) {
                cap_l = cap_l ? cap_l * 2 : 16;
                alc_lines = (char **)realloc(alc_lines, (size_t)cap_l * sizeof(char *));
                if (!alc_lines) { fputs("alcorlang: out of memory\n", stderr); exit(70); }
            }
            { char *line = (char *)alc_alloc(end - start + 1);
              memcpy(line, buf + start, end - start);
              line[end - start] = 0;
              alc_lines[alc_lines_n++] = line; }
            start = k + 1;
        }
    }
}
