import { useState, useEffect, useRef } from 'react';

interface BrowseNode {
  /** MFT record number (NTFS) or start cluster (FAT/exFAT), as sent by main. */
  id: number;
  name: string;
  parentId: number;
  isDirectory: boolean;
  size: number;
  modified?: number;
  isEncrypted?: boolean;
}

interface BrowsePartition {
  partitionIndex: number;
  size: number;
  offsetOnDisk: number;
  blockCount: number;
  /** Detected filesystem (NTFS, FAT32, exFAT, ...). */
  fsType?: string;
  /** Whether the built-in browser can read this partition. */
  browsable?: boolean;
}

interface MountStatus {
  id: string;
  state: string;
  mountPoint?: string;
  ok?: boolean;
  error?: string;
}

interface BrowseViewProps {
  onComplete?: () => void;
  initialImagePath?: string;
  autoMount?: boolean;
}

function BrowseView({ onComplete, initialImagePath, autoMount }: BrowseViewProps) {
  const [imagePath, setImagePath] = useState('');
  const [info, setInfo] = useState<{ encrypted: boolean; partitions: BrowsePartition[] } | null>(null);
  const [partitionIndex, setPartitionIndex] = useState<number | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [cwd, setCwd] = useState('');
  const [nodes, setNodes] = useState<BrowseNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [extracting, setExtracting] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [winfspOk, setWinfspOk] = useState(false);
  const [mountId, setMountId] = useState<string | null>(null);
  const [mountPoint, setMountPoint] = useState('');
  const [mountedOf, setMountedOf] = useState('');

  // Whether the currently selected partition can be browsed.
  const currentPartition = info?.partitions.find((p) => p.partitionIndex === partitionIndex);
  const currentBrowsable = currentPartition ? currentPartition.browsable !== false : false;
  const [mounting, setMounting] = useState(false);
  const [mountError, setMountError] = useState('');
  // The mount-status listener is registered once ([]); it must read the current
  // mount id / image key through refs or it closes over null and drops every event.
  const mountIdRef = useRef<string | null>(null);
  const mountKeyRef = useRef('');

  useEffect(() => {
    void window.electronAPI
      .winfspStatus()
      .then((status: { available: boolean; note?: string }) => {
        setWinfspOk(status.available);
        if (!status.available && status.note && status.note !== 'not attempted') {
          setMountError(`WinFsp not available: ${status.note}`);
        }
      })
      .catch(() => setWinfspOk(false));
    const unsubscribe = window.electronAPI.onMountStatus((status: MountStatus) => {
      // Late/foreign events (previous mount, unmount after navigate) must not
      // touch this view unless they belong to the active mount id.
      if (!mountIdRef.current || status.id !== mountIdRef.current) return;
      if (status.state === 'mounted') {
        setMountPoint(status.mountPoint ?? '');
        setMountedOf(mountKeyRef.current);
        setMounting(false);
        setMountError('');
      } else if (status.state === 'unmounted') {
        if (status.ok === false) {
          setMountError(status.error ?? 'The mount was removed unexpectedly.');
        }
        mountIdRef.current = null;
        mountKeyRef.current = '';
        setMountId(null);
        setMountPoint('');
        setMountedOf('');
        setMounting(false);
      }
    });
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    return () => {
      void window.electronAPI.browseClose();
    };
  }, []);

  useEffect(() => {
    if (imagePath && partitionIndex !== null && currentBrowsable) {
      void loadDirectory('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imagePath, partitionIndex, passphrase]);

  // Auto-mount triggered by context menu "Mount image" verb
  useEffect(() => {
    if (autoMount && imagePath && partitionIndex !== null && currentBrowsable && !mountId && !mounting) {
      void handleMount();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoMount, imagePath, partitionIndex]);

  useEffect(() => {
    if (!initialImagePath) return;
    let alive = true;
    Promise.resolve().then(() => {
      if (alive) void openImage(initialImagePath);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialImagePath]);

  const openImage = async (path: string) => {
    setImagePath(path);
    setPartitionIndex(null);
    setNodes([]);
    setCwd('');
    setNotice('');
    setError('');
    try {
      const loaded = await window.electronAPI.browsePartitions(path);
      setInfo(loaded);
      const browsable = loaded.partitions.filter((p: BrowsePartition) => p.browsable !== false);
      if (browsable.length > 0) {
        setPartitionIndex(browsable[0].partitionIndex);
      } else if (loaded.partitions.length > 0) {
        // Partitions exist but none are browsable — still show the list so the
        // user can see which filesystems are present.
        setPartitionIndex(loaded.partitions[0].partitionIndex);
        setError('No browsable partitions in this image. Only NTFS, FAT32 and exFAT partitions can be browsed.');
      } else {
        setError('This image has no partitions.');
      }
    } catch (e: any) {
      setError(e?.message ?? 'Failed to read the image');
      setInfo(null);
    }
  };

  const handleSelectImage = async () => {
    const path = await window.electronAPI.selectFile({
      filters: [
        { name: 'Backup Images', extensions: ['opbs'] },
        { name: 'Macrium Reflect Images', extensions: ['mrimgx', 'mrimg'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (path) {
      await openImage(path);
    }
  };

  const loadDirectory = async (relPath: string) => {
    if (partitionIndex === null) return;
    setLoading(true);
    setError('');
    try {
      const list = await window.electronAPI.browseList(
        imagePath,
        partitionIndex,
        relPath,
        passphrase || undefined
      );
      setNodes(list);
      setCwd(relPath);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to list directory');
    } finally {
      setLoading(false);
    }
  };

  const joinPath = (base: string, name: string): string => {
    if (!base) return name;
    return `${base}/${name}`;
  };

  const stripLastSegment = (relPath: string): string => {
    if (!relPath) return '';
    const idx = relPath.lastIndexOf('/');
    return idx === -1 ? '' : relPath.slice(0, idx);
  };

  const onEnterDir = (node: BrowseNode) => {
    if (!node.isDirectory) return;
    setExpanded((prev) => new Set(prev).add(node.id));
    void loadDirectory(joinPath(cwd, node.name));
  };

  const onUp = () => {
    void loadDirectory(stripLastSegment(cwd));
  };

  const handleExtract = async (node: BrowseNode) => {
    if (partitionIndex === null) return;
    const relPath = joinPath(cwd, node.name);
    let outPath: string | undefined;
    if (node.isDirectory) {
      // Folder picker: the chosen folder is the destination root, and the
      // directory is recreated inside it as <folder>/<name>.
      outPath = await window.electronAPI.selectDirectory({
        title: `Choose a folder to extract "${node.name}" into`
      });
    } else {
      const suggested = node.name.replace(/[<>:"/\\|?*]/g, '_');
      outPath = await window.electronAPI.selectSaveFile({
        filters: [{ name: 'Extracted files', extensions: ['*'] }],
        name: suggested
      });
    }
    if (!outPath) return;
    setExtracting(node.isDirectory ? `${node.name}/…` : node.name);
    setNotice('');
    try {
      const result = await window.electronAPI.browseExtract(
        imagePath,
        partitionIndex,
        relPath,
        outPath,
        passphrase || undefined
      );
      setNotice(`Extracted ${result.files} item(s) to ${result.outPath}`);
    } catch (e: any) {
      setError(e?.message ?? 'Extraction failed');
    } finally {
      setExtracting(null);
    }
  };

  const handleMount = async (): Promise<void> => {
    if (partitionIndex === null || mountIdRef.current || mounting) return;
    setMounting(true);
    setMountError('');
    try {
      const result = await window.electronAPI.mountImage({
        imagePath,
        partitionIndex,
        label: `OPBS ${imagePath.split(/[\\/]/).pop() ?? 'image'} (partition ${partitionIndex})`,
        passphrase: passphrase || undefined
      });
      // Refs first so a concurrent mount-status event is not dropped.
      const key = `${imagePath}#${partitionIndex}`;
      mountKeyRef.current = key;
      mountIdRef.current = result.id ?? null;
      if (!result.ok || !result.id) {
        setMountError(result.error ?? 'Mount failed');
        setMountId(null);
        setMounting(false);
        setMountPoint('');
        setMountedOf('');
      } else {
        setMountId(result.id);
        // The invoke resolves only after the helper reports mounted, so the
        // bar can flip without depending on a separate progress event.
        setMountPoint(result.mountPoint || '');
        setMountedOf(key);
        setMounting(false);
        setMountError('');
      }
    } catch (e: any) {
      mountIdRef.current = null;
      mountKeyRef.current = '';
      setMountError(e?.message ?? 'Mount failed');
      setMounting(false);
    }
  };

  const handleUnmount = async (): Promise<void> => {
    const id = mountIdRef.current;
    if (!id) return;
    await window.electronAPI.unmountImage(id);
  };

  const formatSize = (bytes: number): string => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  };

  const breadcrumbSegments = cwd ? cwd.split('/') : [];

  return (
    <div className="browse-view">
      <div className="wizard-header">
        <h1>Browse Backup Image</h1>
        <p className="field-hint">
          Inspect and extract individual files from an image without restoring the whole disk.
        </p>
      </div>

      <div className="image-selector">
        <div className="current-path">
          <label>Backup Image:</label>
          <div className="path-input">
            <input type="text" value={imagePath} readOnly placeholder="Select an image file..." />
            <button onClick={handleSelectImage}>Browse</button>
          </div>
        </div>

        {info?.encrypted && (
          <div className="setting-item">
            <label>Passphrase:</label>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Required for encrypted image"
            />
          </div>
        )}

        {info && info.partitions.length > 0 && (
          <div className="setting-item">
            <label>Partition:</label>
            <select
              value={partitionIndex ?? ''}
              onChange={(e) => setPartitionIndex(parseInt(e.target.value))}
            >
              {info.partitions.map((p) => (
                <option
                  key={p.partitionIndex}
                  value={p.partitionIndex}
                  disabled={p.browsable === false}
                >
                  Partition {p.partitionIndex} — {formatSize(p.size)}
                  {p.fsType ? ` (${p.fsType})` : ''}
                  {p.browsable === false ? ' — not browsable' : ''}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {(mountPoint || (mountedOf && mountedOf === `${imagePath}#${partitionIndex}`)) ? (
        <div className="mount-bar mount-active">
          <span className="mount-point">Mounted at {mountPoint || mountedOf}</span>
          <button className="btn-secondary btn-small" onClick={() => void handleUnmount()}>
            Unmount
          </button>
        </div>
      ) : (
        <div className="mount-bar">
          <button
            className="btn-secondary btn-small"
            disabled={mounting || partitionIndex === null || currentPartition?.fsType !== 'NTFS'}
            onClick={() => void handleMount()}
          >
            {mounting ? 'Mounting…' : 'Mount as drive'}
          </button>
          {!winfspOk && <span className="field-hint">WinFsp not installed — mount unavailable.</span>}
          {winfspOk && currentPartition && currentPartition.fsType !== 'NTFS' && (
            <span className="field-hint">Mounting is only supported for NTFS partitions.</span>
          )}
          {mountError && <span className="error-text">{mountError}</span>}
        </div>
      )}

      {error && (
        <div className="error-message">
          <p>{error}</p>
        </div>
      )}

      {notice && (
        <div className="success-message">
          <p>{notice}</p>
        </div>
      )}

      {imagePath && partitionIndex !== null && !currentBrowsable && currentPartition && (
        <div className="error-message">
          <p>
            Partition {currentPartition.partitionIndex} uses {currentPartition.fsType ?? 'an unsupported'} — only
            NTFS, FAT32 and exFAT partitions can be browsed.
          </p>
        </div>
      )}

      {(imagePath && partitionIndex !== null && currentBrowsable) && (
        <div className="file-browser">
          <div className="breadcrumb-bar">
            <button className="btn-secondary btn-small" onClick={onUp} disabled={!cwd}>
              ↑ Up
            </button>
            <div className="breadcrumb">
              <span
                className={`crumb ${cwd === '' ? 'active' : ''}`}
                onClick={() => void loadDirectory('')}
              >
                /
              </span>
              {breadcrumbSegments.map((seg, i) => {
                const crumbPath = breadcrumbSegments.slice(0, i + 1).join('/');
                const isLast = i === breadcrumbSegments.length - 1;
                return (
                  <span key={crumbPath} className="crumb-wrap">
                    <span className="crumb-sep">›</span>
                    <span
                      className={`crumb ${isLast ? 'active' : ''}`}
                      onClick={() => void loadDirectory(crumbPath)}
                    >
                      {seg}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>

          <div className="file-table">
            <div className="file-table-head">
              <span className="col-name">Name</span>
              <span className="col-size">Size</span>
              <span className="col-modified">Modified</span>
              <span className="col-actions" />
            </div>
            {loading ? (
              <p className="table-empty">Loading…</p>
            ) : nodes.length === 0 ? (
              <p className="table-empty">This directory is empty.</p>
            ) : (
              nodes.map((node) => (
                <div className="file-row" key={node.id}>
                  <span
                    className={`col-name node-name ${node.isDirectory ? 'is-dir' : ''}`}
                    onDoubleClick={() => onEnterDir(node)}
                    title={
                      node.isDirectory
                        ? 'Double-click to open'
                        : node.isEncrypted
                          ? `${node.name} — EFS-encrypted (cannot be extracted from the image)`
                          : node.name
                    }
                  >
                    {node.isDirectory ? '📁' : node.isEncrypted ? '🔒' : '📄'} {node.name}
                  </span>
                  <span className="col-size">
                    {node.isDirectory ? '—' : formatSize(node.size)}
                  </span>
                  <span className="col-modified">
                    {node.modified ? new Date(node.modified / 10000 - 11644473600000).toLocaleString() : ''}
                  </span>
                  <span className="col-actions">
                    {node.isDirectory ? (
                      <button className="btn-secondary btn-small" onClick={() => onEnterDir(node)}>
                        Open
                      </button>
                    ) : (
                      <button
                        className="btn-primary btn-small"
                        disabled={node.isEncrypted}
                        onClick={() => void handleExtract(node)}
                        title={
                          node.isEncrypted
                            ? 'EFS-encrypted files cannot be extracted from the image'
                            : undefined
                        }
                      >
                        {node.isEncrypted ? 'Encrypted' : extracting === node.name ? 'Extracting…' : 'Extract'}
                      </button>
                    )}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {onComplete && (
        <div className="wizard-actions">
          <button className="btn-secondary" onClick={onComplete}>
            Back
          </button>
        </div>
      )}
    </div>
  );
}

export default BrowseView;