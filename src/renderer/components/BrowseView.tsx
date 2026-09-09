import { useState, useEffect } from 'react';

interface BrowseNode {
  recordNumber: number;
  name: string;
  parentRecord: number;
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
}

interface BrowseViewProps {
  onComplete?: () => void;
}

function BrowseView({ onComplete }: BrowseViewProps) {
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

  useEffect(() => {
    return () => {
      void window.electronAPI.browseClose();
    };
  }, []);

  useEffect(() => {
    if (imagePath && partitionIndex !== null) {
      void loadDirectory('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imagePath, partitionIndex, passphrase]);

  const handleSelectImage = async () => {
    const path = await window.electronAPI.selectFile({
      filters: [
        { name: 'Backup Images', extensions: ['opbs'] },
        { name: 'Macrium Reflect Images', extensions: ['mrimgx', 'mrimg'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (path) {
      setImagePath(path);
      setPartitionIndex(null);
      setNodes([]);
      setCwd('');
      setNotice('');
      setError('');
      try {
        const loaded = await window.electronAPI.browsePartitions(path);
        setInfo(loaded);
        if (loaded.partitions.length > 0) {
          setPartitionIndex(loaded.partitions[0].partitionIndex);
        }
      } catch (e: any) {
        setError(e?.message ?? 'Failed to read the image');
        setInfo(null);
      }
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
    setExpanded((prev) => new Set(prev).add(node.recordNumber));
    void loadDirectory(joinPath(cwd, node.name));
  };

  const onUp = () => {
    void loadDirectory(stripLastSegment(cwd));
  };

  const handleExtract = async (node: BrowseNode) => {
    if (partitionIndex === null) return;
    const relPath = joinPath(cwd, node.name);
    const suggested = node.name.replace(/[<>:"/\\|?*]/g, '_');
    const outPath = await window.electronAPI.selectSaveFile({
      filters: [{ name: 'Extracted files', extensions: ['*'] }],
      name: suggested
    });
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

        {info && info.partitions.length > 1 && (
          <div className="setting-item">
            <label>Partition:</label>
            <select
              value={partitionIndex ?? ''}
              onChange={(e) => setPartitionIndex(parseInt(e.target.value))}
            >
              {info.partitions.map((p) => (
                <option key={p.partitionIndex} value={p.partitionIndex}>
                  Partition {p.partitionIndex} — {formatSize(p.size)}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

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

      {(imagePath && partitionIndex !== null) && (
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
                <div className="file-row" key={node.recordNumber}>
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