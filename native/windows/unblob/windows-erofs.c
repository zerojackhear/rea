/* SPDX-License-Identifier: MIT */
/* Caller-owned handles only. No mounts, output paths or helper processes. */
#include <config.h>
#define NOMINMAX
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "erofs/dir.h"
#include "erofs/io.h"

#define LIMIT_ENTRIES 10000u
#define LIMIT_OUTPUT (512ull * 1024 * 1024)
#define API __declspec(dllexport)

struct entry {
    uint64_t nid, size;
    uint32_t parent, mode, xattrs, depth;
    int status;
    uint16_t name_length;
    char name[256];
};
struct session {
    struct erofs_sb_info sb;
    uint32_t count, errors;
    int last_error;
    struct entry entries[LIMIT_ENTRIES];
};
struct context {
    struct erofs_dir_context dir;
    struct session *session;
    uint32_t parent;
};

static int append_entry(struct erofs_dir_context *dir) {
    struct context *ctx = (struct context *)dir;
    struct session *s = ctx->session;
    struct erofs_inode inode = {.sbi = &s->sb, .nid = dir->de_nid};
    struct entry *entry;
    uint32_t i;
    int ret;
    if (dir->dot_dotdot) return 0;
    if (s->count >= LIMIT_ENTRIES) return -EFBIG;
    if (!dir->de_namelen || dir->de_namelen >= sizeof(s->entries[0].name) ||
        memchr(dir->dname, '\0', dir->de_namelen) ||
        memchr(dir->dname, '/', dir->de_namelen)) return -EFSCORRUPTED;
    ret = erofs_read_inode_from_disk(&inode);
    if (ret) return ret;
    if ((S_ISDIR(inode.i_mode) && dir->de_ftype != EROFS_FT_DIR) ||
        (S_ISREG(inode.i_mode) && dir->de_ftype != EROFS_FT_REG_FILE)) return -EFSCORRUPTED;
    if (S_ISDIR(inode.i_mode)) {
        if (s->entries[ctx->parent].depth >= 128 || inode.i_size > LIMIT_OUTPUT) return -EFBIG;
        for (i = 0; i < s->count; ++i)
            if (S_ISDIR(s->entries[i].mode) && s->entries[i].nid == dir->de_nid) return -ELOOP;
    }
    entry = &s->entries[s->count++];
    entry->nid = dir->de_nid; entry->size = inode.i_size;
    entry->parent = ctx->parent; entry->mode = inode.i_mode;
    entry->xattrs = inode.xattr_isize; entry->depth = s->entries[ctx->parent].depth + 1;
    entry->name_length = dir->de_namelen;
    memcpy(entry->name, dir->dname, dir->de_namelen);
    return 0;
}

API int reaer_close(struct session *s) {
    int ret;
    if (!s) return -EINVAL;
    erofs_put_super(&s->sb);
    ret = _close(s->sb.bdev.fd);
    free(s);
    return ret ? -EIO : 0;
}

API int reaer_open(HANDLE source, struct session **result) {
    struct session *s;
    struct erofs_inode root;
    LARGE_INTEGER size;
    HANDLE duplicate;
    int fd, ret;
    uint32_t i;
    if (!result) return -EINVAL;
    *result = NULL;
    if (GetFileType(source) != FILE_TYPE_DISK || !GetFileSizeEx(source, &size) ||
        size.QuadPart < 1152 || size.QuadPart > 128ll * 1024 * 1024) return -EFBIG;
    if (!DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &duplicate,
                         GENERIC_READ, FALSE, 0)) return -EACCES;
    fd = _open_osfhandle((intptr_t)duplicate, _O_RDONLY | _O_BINARY);
    if (fd < 0) { CloseHandle(duplicate); return -EMFILE; }
    s = calloc(1, sizeof(*s));
    if (!s) { _close(fd); return -ENOMEM; }
    s->sb.bdev.fd = fd; s->sb.devsz = size.QuadPart;
    ret = erofs_read_superblock(&s->sb);
    if (!ret && s->sb.extra_devices) ret = -ENODEV;
    if (!ret && s->sb.dif0.blocks > ((uint64_t)size.QuadPart >> s->sb.blkszbits)) ret = -EIO;
    if (!ret && (s->sb.feature_compat & EROFS_FEATURE_COMPAT_SB_CHKSUM))
        ret = erofs_superblock_csum_verify(&s->sb);
    if (ret) { reaer_close(s); return ret; }
    memset(&root, 0, sizeof(root)); root.sbi = &s->sb; root.nid = s->sb.root_nid;
    ret = erofs_read_inode_from_disk(&root);
    if (!ret && (!S_ISDIR(root.i_mode) || root.i_size > LIMIT_OUTPUT)) ret = -EFSCORRUPTED;
    if (ret) { reaer_close(s); return ret; }
    s->entries[0].nid = root.nid; s->entries[0].mode = root.i_mode;
    s->entries[0].size = root.i_size; s->count = 1;
    for (i = 0; i < s->count; ++i) {
        struct entry *entry = &s->entries[i];
        struct erofs_inode inode = {.sbi = &s->sb, .nid = entry->nid};
        struct context ctx;
        if (!S_ISDIR(entry->mode)) continue;
        ret = erofs_read_inode_from_disk(&inode);
        if (!ret) {
            memset(&ctx, 0, sizeof(ctx)); ctx.session = s; ctx.parent = i;
            ctx.dir.dir = &inode; ctx.dir.cb = append_entry;
            ctx.dir.pnid = s->entries[entry->parent].nid;
            ctx.dir.flags = EROFS_READDIR_VALID_PNID;
            ret = erofs_iterate_dir(&ctx.dir, true);
        }
        if (ret) { entry->status = ret; s->errors++; s->last_error = ret; }
    }
    *result = s;
    return 0;
}

API int reaer_count(struct session *s, uint32_t *count, uint32_t *errors, int *last_error) {
    if (!s || !count || !errors || !last_error) return -EINVAL;
    *count = s->count; *errors = s->errors; *last_error = s->last_error;
    return 0;
}

API int reaer_item(struct session *s, uint32_t index, char *name, uint32_t capacity,
                  uint32_t *name_length, uint32_t *parent, uint32_t *mode,
                  uint64_t *size, uint32_t *xattrs, int *status) {
    struct entry *entry;
    if (!s || index >= s->count || !name || !name_length || !parent || !mode ||
        !size || !xattrs || !status) return -EINVAL;
    entry = &s->entries[index];
    if (capacity < entry->name_length) return -ERANGE;
    memcpy(name, entry->name, entry->name_length);
    *name_length = entry->name_length; *parent = entry->parent; *mode = entry->mode;
    *size = entry->size; *xattrs = entry->xattrs; *status = entry->status;
    return 0;
}

API int reaer_read(struct session *s, uint32_t index, uint64_t offset,
                  void *buffer, uint32_t length) {
    struct erofs_inode inode;
    struct erofs_vfile vf;
    struct entry *entry;
    int ret;
    if (!s || index >= s->count || !buffer || length > 65536) return -EINVAL;
    entry = &s->entries[index];
    if (!S_ISREG(entry->mode) || offset > entry->size || length > entry->size - offset)
        return -EINVAL;
    memset(&inode, 0, sizeof(inode)); inode.sbi = &s->sb; inode.nid = entry->nid;
    ret = erofs_read_inode_from_disk(&inode);
    if (!ret && (inode.i_size != entry->size || inode.i_mode != entry->mode)) ret = -EIO;
    if (!ret) ret = erofs_iopen(&vf, &inode);
    if (!ret) ret = erofs_pread(&vf, buffer, length, offset);
    return ret;
}
