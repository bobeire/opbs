{
  "targets": [
    {
      "target_name": "opbs_native",
      "sources": [
        "src/addon.cpp",
        "src/zstd.cpp",
        "src/partition_table.cpp",
        "src/vss_manager.cpp",
        "src/disk_reader.cpp",
        "src/backup_format.cpp",
        "src/winfsp_mount.cpp",
        "vendor/zstd/common/entropy_common.c",
        "vendor/zstd/common/error_private.c",
        "vendor/zstd/common/fse_decompress.c",
        "vendor/zstd/common/xxhash.c",
        "vendor/zstd/common/zstd_common.c",
        "vendor/zstd/common/pool.c",
        "vendor/zstd/common/threading.c",
        "vendor/zstd/common/debug.c",
        "vendor/zstd/compress/fse_compress.c",
        "vendor/zstd/compress/hist.c",
        "vendor/zstd/compress/huf_compress.c",
        "vendor/zstd/compress/zstd_compress.c",
        "vendor/zstd/compress/zstd_compress_literals.c",
        "vendor/zstd/compress/zstd_compress_sequences.c",
        "vendor/zstd/compress/zstd_compress_superblock.c",
        "vendor/zstd/compress/zstd_double_fast.c",
        "vendor/zstd/compress/zstd_fast.c",
        "vendor/zstd/compress/zstd_lazy.c",
        "vendor/zstd/compress/zstd_ldm.c",
        "vendor/zstd/compress/zstd_opt.c",
        "vendor/zstd/compress/zstdmt_compress.c",
        "vendor/zstd/decompress/huf_decompress.c",
        "vendor/zstd/decompress/zstd_ddict.c",
        "vendor/zstd/decompress/zstd_decompress.c",
        "vendor/zstd/decompress/zstd_decompress_block.c"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "vendor/winfsp",
        "vendor/zstd",
        "vendor/zstd/common"
      ],
      "libraries": [
        "-lole32",
        "-loleaut32",
        "-luuid",
        "-ladvapi32"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "DebugInformationFormat": 3,
          "WholeProgramOptimization": "false"
        },
        "VCLinkerTool": {
          "GenerateDebugInformation": "true"
        }
      },
"conditions": [
            [
              "OS=='win'",
              {
                "libraries": [
                  "-lole32",
                  "-loleaut32",
                  "-luuid",
                  "-ladvapi32",
                  "-lBcrypt",
                  "-lrpcrt4",
                  "-lsetupapi",
                  "-lvssapi",
                  "-ldbghelp"
                ]
              }
            ]
          ]
    }
  ]
}
