/* SPDX-License-Identifier: MIT */
/* Fixed read-only ARC/StuffIt adapters. Input handles, never host paths. */
#import <Foundation/Foundation.h>
#import "XADARCParser.h"
#import "XADStuffItParser.h"
#import "XADStuffIt5Parser.h"
#import "CSMemoryHandle.h"
#include <windows.h>
#include <stdint.h>
#include <errno.h>

#define API __declspec(dllexport)
#define MAX_ENTRIES 10000u
#define MAX_OUTPUT (512ull * 1024 * 1024)

@interface REAXADInventory : NSObject {
@public NSMutableArray *entries;
}
@end
@implementation REAXADInventory
-(id)init { if ((self=[super init])) entries=[NSMutableArray new]; return self; }
-(void)dealloc { [entries release]; [super dealloc]; }
-(void)archiveParser:(XADArchiveParser *)parser foundEntryWithDictionary:(NSDictionary *)entry {
    if ([entries count] >= MAX_ENTRIES) [NSException raise:@"REAEntryLimit" format:@"Archive entry limit reached"];
    [entries addObject:[[entry copy] autorelease]];
}
-(BOOL)archiveParsingShouldStop:(XADArchiveParser *)parser { return NO; }
-(void)archiveParserNeedsPassword:(XADArchiveParser *)parser {
    [NSException raise:@"REANoCredential" format:@"No archive credential was supplied"];
}
@end

struct session {
    XADArchiveParser *parser;
    REAXADInventory *inventory;
    CSHandle *stream;
    HANDLE file, mapping;
    void *view;
    uint64_t remaining;
    int parse_error;
    char error[2048];
};

static int fail(struct session *s, NSException *exception) {
    const char *text=[[exception description] UTF8String];
    if (s) snprintf(s->error,sizeof(s->error),"%s",text?text:"Native archive exception");
    return -EIO;
}
static unsigned flags(NSDictionary *entry) {
    unsigned f=0;
    if ([[entry objectForKey:XADIsDirectoryKey] boolValue]) f|=1;
    if ([[entry objectForKey:XADIsResourceForkKey] boolValue]) f|=2;
    if ([[entry objectForKey:XADIsLinkKey] boolValue] || [[entry objectForKey:XADIsHardLinkKey] boolValue] ||
        [[entry objectForKey:XADIsCharacterDeviceKey] boolValue] || [[entry objectForKey:XADIsBlockDeviceKey] boolValue] ||
        [[entry objectForKey:XADIsFIFOKey] boolValue]) f|=4;
    if ([[entry objectForKey:XADIsEncryptedKey] boolValue]) f|=8;
    if ([[entry objectForKey:XADIsCorruptedKey] boolValue]) f|=16;
    return f;
}

API int reaxad_close(struct session *s) {
    if (!s) return -EINVAL;
    @autoreleasepool {
        @try {
            [s->stream release]; s->stream=nil;
            [s->parser release]; s->parser=nil;
            [s->inventory release]; s->inventory=nil;
        } @catch(NSException *e) { return fail(s,e); }
    }
    if (s->view) { if (!UnmapViewOfFile(s->view)) return -EIO; s->view=NULL; }
    if (s->mapping) { if (!CloseHandle(s->mapping)) return -EIO; s->mapping=NULL; }
    if (s->file) { if (!CloseHandle(s->file)) return -EIO; s->file=NULL; }
    free(s); return 0;
}

API int reaxad_open(HANDLE source, unsigned kind, struct session **result) {
    LARGE_INTEGER size;
    if (!result || kind>2) return -EINVAL;
    *result=NULL;
    if (GetFileType(source)!=FILE_TYPE_DISK || !GetFileSizeEx(source,&size) ||
            size.QuadPart<=0 || size.QuadPart>128ll*1024*1024) return -EFBIG;
    struct session *s=calloc(1,sizeof(*s)); if (!s) return -ENOMEM;
    // Return owned state even when initialization fails, so cleanup can retry.
    *result=s;
    if (!DuplicateHandle(GetCurrentProcess(),source,GetCurrentProcess(),&s->file,GENERIC_READ,FALSE,0)) return -EACCES;
    s->mapping=CreateFileMappingW(s->file,NULL,PAGE_READONLY,0,0,NULL);
    if (!s->mapping) return -EIO;
    s->view=MapViewOfFile(s->mapping,FILE_MAP_READ,0,0,(SIZE_T)size.QuadPart);
    if (!s->view) return -EIO;
    @autoreleasepool {
        @try {
            NSData *bytes=[NSData dataWithBytesNoCopy:s->view length:(NSUInteger)size.QuadPart freeWhenDone:NO];
            CSMemoryHandle *handle=[CSMemoryHandle memoryHandleForReadingData:bytes];
            Class parserClass=kind==0?[XADARCParser class]:(kind==1?[XADStuffItParser class]:[XADStuffIt5Parser class]);
            s->parser=[parserClass new];
            [s->parser setHandle:handle]; [s->parser setName:@"selected-input"];
            s->inventory=[REAXADInventory new]; [s->parser setDelegate:s->inventory];
            s->parse_error=[s->parser parseWithoutExceptions];
            return 0;
        } @catch(NSException *e) { return fail(s,e); }
    }
}

API int reaxad_count(struct session *s, unsigned *count, int *error) {
    if (!s || !s->inventory || !count || !error) return -EINVAL;
    *count=(unsigned)[s->inventory->entries count]; *error=s->parse_error; return 0;
}

API int reaxad_item(struct session *s, unsigned index, void *buffer, unsigned capacity,
        unsigned *length, uint64_t *size, unsigned *entryflags) {
    if (!s || !s->inventory || index >= [s->inventory->entries count] || !buffer ||
            capacity>65536 || !length || !size || !entryflags) return -EINVAL;
    s->error[0]=0;
    @autoreleasepool {
        @try {
            NSDictionary *entry=[s->inventory->entries objectAtIndex:index];
            XADPath *path=[entry objectForKey:XADFileNameKey];
            NSData *raw=[path data];
            if (!path || !raw || [raw length]>4096) return -EFBIG;
            NSString *display=[path string];
            if (display && [display length]>4096) return -EFBIG;
            *entryflags=flags(entry);
            NSNumber *number=[entry objectForKey:XADFileSizeKey];
            if (!(*entryflags&1) && (!number || [number longLongValue]<0)) return -EINVAL;
            *size=number?[number unsignedLongLongValue]:0;
            NSString *encoding=[path encodingName];
            if (encoding && [encoding length]>128) return -EFBIG;
            NSDictionary *metadata=@{
                @"decoder_path_base64":[raw base64EncodedStringWithOptions:0],
                @"display_name":display ?: [NSNull null],
                @"encoding":encoding ?: [NSNull null],
                @"encoding_known":[NSNumber numberWithBool:[path encodingIsKnown]],
                @"resource_fork":[NSNumber numberWithBool:((*entryflags&2)!=0)],
                @"directory":[NSNumber numberWithBool:((*entryflags&1)!=0)],
                @"declared_bytes":@(*size)
            };
            NSData *json=[NSJSONSerialization dataWithJSONObject:metadata options:0 error:NULL];
            if (!json || [json length]>capacity) return -ERANGE;
            *length=(unsigned)[json length]; memcpy(buffer,[json bytes],*length); return 0;
        } @catch(NSException *e) { return fail(s,e); }
    }
}

API int reaxad_begin(struct session *s, unsigned index, unsigned *has_checksum) {
    if (!s || !s->inventory || index >= [s->inventory->entries count] || !has_checksum) return -EINVAL;
    s->error[0]=0;
    @autoreleasepool {
        @try {
            [s->stream release]; s->stream=nil;
            NSDictionary *entry=[s->inventory->entries objectAtIndex:index];
            unsigned f=flags(entry);
            if (f & (1|4|8|16)) return -EACCES;
            NSNumber *number=[entry objectForKey:XADFileSizeKey];
            if (!number || [number longLongValue]<0 || [number unsignedLongLongValue]>MAX_OUTPUT) return -EFBIG;
            s->remaining=[number unsignedLongLongValue];
            s->stream=[[s->parser handleForEntryWithDictionary:entry wantChecksum:YES] retain];
            if (!s->stream) return -ENOTSUP;
            *has_checksum=[s->stream hasChecksum]?1:0; return 0;
        } @catch(NSException *e) { return fail(s,e); }
    }
}

API int reaxad_read(struct session *s, void *buffer, unsigned capacity) {
    if (!s || !s->stream || !buffer || !capacity || capacity>65536) return -EINVAL;
    s->error[0]=0;
    @autoreleasepool {
        @try {
            if (!s->remaining) {
                unsigned char extra;
                if ([s->stream readAtMost:1 toBuffer:&extra]!=0) return -EFBIG;
                if ([s->stream hasChecksum] && ![s->stream isChecksumCorrect]) {
                    snprintf(s->error,sizeof(s->error),"Archive data checksum mismatch"); return -EIO;
                }
                return 0;
            }
            unsigned count=(unsigned)MIN((uint64_t)capacity,s->remaining);
            int actual=[s->stream readAtMost:count toBuffer:buffer];
            if (actual<=0 || actual>count) return -EIO;
            s->remaining-=actual; return actual;
        } @catch(NSException *e) { return fail(s,e); }
    }
}

API int reaxad_error(struct session *s, char *buffer, unsigned capacity) {
    if (!s || !buffer || !capacity) return -EINVAL;
    unsigned length=(unsigned)strlen(s->error);
    if (length>=capacity) return -ERANGE;
    memcpy(buffer,s->error,length+1); return 0;
}
