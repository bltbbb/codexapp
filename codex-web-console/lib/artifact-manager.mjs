import fs from 'node:fs';
import path from 'node:path';
import {
  createId,
  guessArtifactKind,
  guessMimeType,
  isSubPath,
  nowIso,
} from './utils.mjs';

export class ArtifactManager {
  constructor(options) {
    this.sessionStore = options.sessionStore;
    this.allowedRoots = Array.isArray(options.allowedRoots) ? options.allowedRoots : [];
    this.artifacts = new Map();
    this.rebuild();
  }

  rebuild() {
    this.artifacts.clear();
    for (const session of this.sessionStore.getAll()) {
      for (const artifact of session.artifacts) {
        this.artifacts.set(artifact.id, artifact);
      }
    }
  }

  register(sessionId, filePath, source = 'reply') {
    const resolved = path.resolve(filePath);
    if (!this.isAllowedPath(resolved)) {
      return null;
    }

    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return null;
    }

    const session = this.sessionStore.get(sessionId);
    if (!session) {
      return null;
    }

    const existing = session.artifacts.find((item) => item.path === resolved);
    if (existing) {
      this.artifacts.set(existing.id, existing);
      return existing;
    }

    const stat = fs.statSync(resolved);
    const artifact = {
      id: createId('art'),
      sessionId,
      name: path.basename(resolved),
      path: resolved,
      size: stat.size,
      mimeType: guessMimeType(resolved),
      kind: guessArtifactKind(resolved),
      createdAt: nowIso(),
      source,
    };

    const stored = this.sessionStore.addArtifact(sessionId, artifact);
    if (stored) {
      this.artifacts.set(stored.id, stored);
    }
    return stored;
  }

  get(artifactId) {
    return this.artifacts.get(artifactId) || null;
  }

  findByPath(filePath) {
    const resolved = path.resolve(String(filePath || ''));
    if (!resolved) {
      return null;
    }

    for (const artifact of this.artifacts.values()) {
      if (path.resolve(String(artifact?.path || '')) === resolved) {
        return artifact;
      }
    }

    return null;
  }

  readTextPreview(artifact, options = {}) {
    if (!artifact || artifact.kind !== 'text') {
      return null;
    }

    if (!fs.existsSync(artifact.path) || !fs.statSync(artifact.path).isFile()) {
      return null;
    }

    const maxLines = Number.isFinite(options.maxLines) ? options.maxLines : 200;
    const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 16000;
    const content = fs.readFileSync(artifact.path, 'utf8');
    const clipped = content.slice(0, maxChars);
    const lines = clipped.split(/\r?\n/).slice(0, maxLines);

    return {
      name: artifact.name,
      path: artifact.path,
      truncated: content.length > clipped.length || content.split(/\r?\n/).length > lines.length,
      text: lines.join('\n'),
    };
  }

  isAllowedPath(filePath) {
    return this.allowedRoots.some((root) => isSubPath(root, filePath));
  }
}
