# FOSS Backup Solution - Project Plan

## Overview

A simplified FOSS backup solution similar to Macrium Reflect, focusing on **disk imaging** for Windows. Built with Electron + React for a modern, user-friendly interface.

## Project Goals

1. **Disk Imaging**: Full system/partition backup to compressed image files
2. **VSS Support**: Backup live systems using Windows Volume Shadow Copy Service
3. **Simple UI**: Clean, intuitive interface for non-technical users
4. **Open Source**: Fully FOSS with no paywalled features
5. **Portable**: Run from USB without installation (optional)

## Core Features

### Phase 1: Disk Imaging (MVP)
- [ ] Disk/partition detection and enumeration
- [ ] Full disk imaging (bit-for-bit or block-level)
- [ ] VSS integration for live system backup
- [ ] Custom compressed image format (`.opbs`)
- [ ] Image verification (checksums)
- [ ] Basic restore functionality
- [ ] Backup scheduling (daily/weekly/manual)

### Phase 2: Enhanced Features
- [ ] Incremental backups (track changed blocks)
- [ ] Differential backups
- [ ] Backup chain management
- [ ] Bootable rescue media creation (USB/ISO)
- [ ] Image browsing (mount and explore files)
- [ ] Encryption (AES-256)

### Phase 3: Advanced Features
- [ ] Bare metal restore to different hardware
- [ ] Disk cloning (disk-to-disk)
- [ ] Network backup support (NAS/SMB)
- [ ] Email notifications
- [ ] Backup retention policies

## Technical Architecture

### Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | React + TypeScript | UI components |
| Desktop | Electron | Native Windows app |
| Backend | Node.js (main process) | Core logic |
| Native | C++ (N-API addon) | VSS, disk I/O |
| Build | electron-builder | Packaging |

### System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   ELECTRON MAIN PROCESS                 │
│  ┌─────────────────────────────────────────────────┐   │
│  │              Core Engine (Node.js)               │   │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────────┐    │   │
│  │  │ Backup  │  │ Restore │  │  Scheduler  │    │   │
│  │  │ Manager │  │ Manager │  │  (node-cron) │    │   │
│  │  └────┬────┘  └────┬────┘  └──────┬──────┘    │   │
│  │       │             │              │            │   │
│  │  ┌────▼─────────────▼──────────────▼──────┐    │   │
│  │  │        Native Bridge (N-API)            │    │   │
│  │  └────────────────┬───────────────────────┘    │   │
│  └───────────────────┼────────────────────────────┘   │
│                      │                                │
│  ┌───────────────────▼────────────────────────────┐   │
│  │         Native Addon (C++)                      │   │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────────┐    │   │
│  │  │   VSS   │  │  Disk   │  │  Image      │    │   │
│  │  │ Manager │  │ Reader  │  │  Compressor │    │   │
│  │  └─────────┘  └─────────┘  └─────────────┘    │   │
│  └────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                    REACT UI (Renderer)                   │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  │
│  │Dashboard│  │ Backup  │  │ Restore │  │ Settings│  │
│  │         │  │  Wizard │  │  Wizard │  │         │  │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Native Addon Components

#### 1. VSS Manager (`vss_manager.cpp`)
- Interfaces with Windows VSS COM APIs
- Creates/destroys shadow copies
- Provides snapshot device paths for reading
- Handles writer metadata and metadata generation

#### 2. Disk Reader (`disk_reader.cpp`)
- Opens physical drives (`\\.\PhysicalDriveN`)
- Reads raw disk sectors
- Supports both MBR and GPT partition tables
- Handles locked/system volumes via VSS

#### 3. Image Format (`backup_format.cpp`)
- Custom `.opbs` format
- Block-level storage with compression (zstd)
- Indexed access for fast restore
- Metadata header with backup info

## Custom Image Format Specification

```
┌─────────────────────────────────────┐
│           FILE HEADER               │
│  - Magic bytes: "OPBS"             │
│  - Version: uint32                  │
│  - Timestamp: uint64                │
│  - Source disk info                 │
│  - Compression algorithm            │
│  - Encryption flag                 │
│  - Checksum (SHA-256)              │
├─────────────────────────────────────┤
│         PARTITION TABLE             │
│  - Array of partition entries       │
│  - Each entry: offset, size, type  │
├─────────────────────────────────────┤
│           BLOCK INDEX               │
│  - Array of block offsets           │
│  - Enables random access           │
├─────────────────────────────────────┤
│         COMPRESSED DATA             │
│  - Zstd-compressed blocks          │
│  - Block size: 1MB (configurable)  │
└─────────────────────────────────────┘
```

## Project Structure

```
opbs/
├── package.json
├── tsconfig.json
├── electron-builder.yml
├── src/
│   ├── main/                        # Electron main process
│   │   ├── index.ts                 # Main entry point
│   │   ├── ipc-handlers.ts          # IPC communication
│   │   ├── backup/
│   │   │   ├── manager.ts           # Backup orchestration
│   │   │   ├── scheduler.ts         # Scheduled backups
│   │   │   └── verification.ts      # Image verification
│   │   ├── restore/
│   │   │   └── manager.ts           # Restore orchestration
│   │   └── utils/
│   │       ├── disk-info.ts         # Disk enumeration
│   │       └── logger.ts            # Logging
│   ├── renderer/                    # React frontend
│   │   ├── index.html
│   │   ├── main.tsx                 # React entry
│   │   ├── App.tsx                  # Main app component
│   │   ├── components/
│   │   │   ├── Dashboard.tsx        # Main dashboard
│   │   │   ├── BackupWizard.tsx     # Backup creation
│   │   │   ├── RestoreWizard.tsx    # Restore process
│   │   │   ├── DiskSelector.tsx     # Disk/partition picker
│   │   │   ├── ProgressDisplay.tsx  # Progress tracking
│   │   │   └── Settings.tsx         # App settings
│   │   ├── hooks/
│   │   │   └── useBackup.ts         # Backup state hook
│   │   └── styles/
│   │       └── globals.css          # Global styles
│   └── native/                      # C++ native addon
│       ├── binding.gyp              # Node-gyp config
│       ├── src/
│       │   ├── addon.cpp            # N-API entry
│       │   ├── vss_manager.cpp      # VSS implementation
│       │   ├── vss_manager.h
│       │   ├── disk_reader.cpp      # Raw disk I/O
│       │   ├── disk_reader.h
│       │   ├── backup_format.cpp    # Image format
│       │   └── backup_format.h
│       └── package.json
├── test/
│   ├── unit/
│   └── integration/
└── resources/
    ├── icon.ico
    └── installer/
```

## Key Technical Challenges & Solutions

### Challenge 1: Accessing Locked Volumes
**Solution**: Use Windows VSS (Volume Shadow Copy Service)
- Create shadow copy of target volume
- Read from shadow copy device path (`\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopyN`)
- Requires Administrator privileges (UAC prompt)

### Challenge 2: Raw Disk Reading
**Solution**: Direct physical drive access
- Open `\\.\PhysicalDriveN` with `GENERIC_READ`
- Requires Admin privileges
- Read sector-by-sector or in large blocks

### Challenge 3: Performance
**Solution**: Multi-threaded architecture
- Main thread: UI and coordination
- Worker threads: Disk reading, compression, I/O
- Streaming compression (zstd) to avoid memory issues

### Challenge 4: Image Integrity
**Solution**: Checksum verification
- SHA-256 for entire image
- Per-block checksums for partial verification
- Verify after backup completes

## UI Design Principles

1. **Wizard-based workflows**: Step-by-step for backup and restore
2. **Clear progress indicators**: Real-time progress with speed/ETA
3. **Disk visualization**: Visual representation of disks and partitions
4. **Minimal options by default**: Advanced options hidden but accessible
5. **Confirmation dialogs**: Critical operations require confirmation

## Development Phases

### Phase 1: Foundation (Weeks 1-2)
- [ ] Project setup (Electron + React + TypeScript)
- [ ] Basic UI shell with navigation
- [ ] Native addon skeleton
- [ ] Disk enumeration (read-only)

### Phase 2: Backup Engine (Weeks 3-4)
- [ ] VSS integration
- [ ] Raw disk reading
- [ ] Image format implementation
- [ ] Compression (zstd)

### Phase 3: Backup UI (Weeks 5-6)
- [ ] Backup wizard UI
- [ ] Disk/partition selection
- [ ] Progress tracking
- [ ] Backup management list

### Phase 4: Restore (Weeks 7-8)
- [ ] Image parsing
- [ ] Restore wizard UI
- [ ] Partition writing
- [ ] Verification

### Phase 5: Polish (Weeks 9-10)
- [ ] Scheduling
- [ ] Error handling
- [ ] Logging
- [ ] Installer/packaging

## Dependencies

### Node.js
- `electron` - Desktop framework
- `electron-builder` - Packaging
- `node-cron` - Scheduling
- `zstd` (via native) - Compression

### Native (C++)
- Windows VSS API (vssapi.dll)
- Windows SetupAPI (disk enumeration)
- zstd library (compression)

## Legal Considerations

- License: GPL-3.0 or MIT
- No proprietary dependencies
- Clearly document that user runs at own risk
- Backup is not guaranteed - always test restores

## Testing Strategy

1. **Unit tests**: Individual components
2. **Integration tests**: Full backup/restore cycles
3. **Manual testing**: Real hardware scenarios
4. **Virtual machine testing**: Various Windows versions
5. **Edge cases**: Corrupted disks, full disks, network drives
