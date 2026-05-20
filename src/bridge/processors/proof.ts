/**
 * ProofGenerator — 生成 Merkle 证明
 * 将桥接事件构建为 Merkle 叶子，生成证明用于目标链验证
 */

import { createHash } from 'crypto';
import { Logger } from '../../infra/logger/Logger.js';
import type { BridgeEvent, BridgeProof, RelayerSignature } from '../config.js';

// ── Merkle 树实现 ──

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

function computeLeaf(event: BridgeEvent): Buffer {
  // 叶子 = sha256( event_id || nonce || sender || recipient || amount || token || source_chain || target_chain )
  const parts = [
    Buffer.from(event.id, 'utf-8'),
    Buffer.from(event.nonce, 'utf-8'),
    Buffer.from(event.sender, 'utf-8'),
    Buffer.from(event.recipient, 'utf-8'),
    Buffer.from(event.amount, 'utf-8'),
    Buffer.from(event.token, 'utf-8'),
    Buffer.from(event.source_chain, 'utf-8'),
    Buffer.from(event.target_chain, 'utf-8'),
  ];
  const combined = Buffer.concat(parts);
  return sha256(combined);
}

function computeNode(left: Buffer, right: Buffer): Buffer {
  // 排序后哈希，确保确定性
  const ordered = Buffer.compare(left, right) <= 0
    ? Buffer.concat([left, right])
    : Buffer.concat([right, left]);
  return sha256(ordered);
}

function buildMerkleTree(leaves: Buffer[]): { root: Buffer; layers: Buffer[][] } {
  if (leaves.length === 0) {
    const emptyHash = sha256(Buffer.alloc(32));
    return { root: emptyHash, layers: [[emptyHash]] };
  }

  const layers: Buffer[][] = [leaves];
  let currentLayer = leaves;

  while (currentLayer.length > 1) {
    const nextLayer: Buffer[] = [];
    for (let i = 0; i < currentLayer.length; i += 2) {
      const left = currentLayer[i];
      const right = i + 1 < currentLayer.length ? currentLayer[i + 1] : left;
      nextLayer.push(computeNode(left, right));
    }
    layers.push(nextLayer);
    currentLayer = nextLayer;
  }

  return { root: currentLayer[0], layers };
}

function generateMerkleProof(leafIndex: number, layers: Buffer[][]): string[] {
  const proof: string[] = [];
  let index = leafIndex;

  for (let i = 0; i < layers.length - 1; i++) {
    const layer = layers[i];
    const isRightNode = index % 2 === 1;
    const siblingIndex = isRightNode ? index - 1 : index + 1;

    if (siblingIndex < layer.length) {
      proof.push('0x' + layer[siblingIndex].toString('hex'));
    } else {
      // 奇数节点，用自身作为兄弟
      proof.push('0x' + layer[index].toString('hex'));
    }

    index = Math.floor(index / 2);
  }

  return proof;
}

// ── ProofGenerator 类 ──

export class ProofGenerator {
  private logger: Logger;
  private eventBuffer: BridgeEvent[] = [];
  private leafMap = new Map<string, { leaf: Buffer; index: number }>();
  private currentRoot: Buffer | null = null;
  private currentLayers: Buffer[][] | null = null;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * 添加事件到 Merkle 池
   * 事件进入缓冲区后，可随时生成证明
   */
  addEvent(event: BridgeEvent): void {
    // 检查是否已存在
    if (this.leafMap.has(event.id)) {
      this.logger.debug('Event already in Merkle pool', { id: event.id });
      return;
    }

    const leaf = computeLeaf(event);
    const index = this.eventBuffer.length;

    this.eventBuffer.push(event);
    this.leafMap.set(event.id, { leaf, index });

    // 每次有新事件就重建树（生产环境可用增量更新优化）
    this.rebuildTree();

    this.logger.debug('Event added to Merkle pool', {
      id: event.id,
      pool_size: this.eventBuffer.length,
    });
  }

  /**
   * 为指定事件生成 Merkle 证明
   */
  generateProof(
    eventId: string,
    signatures: RelayerSignature[] = [],
  ): BridgeProof | null {
    const entry = this.leafMap.get(eventId);
    if (!entry || !this.currentRoot || !this.currentLayers) {
      this.logger.warn('Cannot generate proof: event not found or tree empty', { eventId });
      return null;
    }

    const proof = generateMerkleProof(entry.index, this.currentLayers);

    return {
      event_id: eventId,
      merkle_root: '0x' + this.currentRoot.toString('hex'),
      merkle_proof: proof,
      leaf_hash: '0x' + entry.leaf.toString('hex'),
      signatures,
      created_at: Date.now(),
    };
  }

  /**
   * 验证 Merkle 证明的有效性
   */
  verifyProof(proof: BridgeProof): boolean {
    if (!this.currentRoot) return false;

    let hash: Buffer = Buffer.from(proof.leaf_hash.slice(2), 'hex');

    for (const proofElement of proof.merkle_proof) {
      const sibling: Buffer = Buffer.from(proofElement.slice(2), 'hex');
      hash = computeNode(hash, sibling) as Buffer;
    }

    const expectedRoot = '0x' + this.currentRoot.toString('hex');
    return hash.toString('hex') === this.currentRoot.toString('hex');
  }

  /**
   * 验证桥接事件的有效性
   * 检查金额、地址格式、nonce 等
   */
  validateEvent(event: BridgeEvent): { valid: boolean; error?: string } {
    // 检查金额 > 0
    try {
      const amount = BigInt(event.amount);
      if (amount <= 0n) {
        return { valid: false, error: 'Amount must be greater than 0' };
      }
    } catch {
      return { valid: false, error: 'Invalid amount format' };
    }

    // 检查地址格式
    if (event.source_chain === 'evm' && !/^0x[0-9a-fA-F]{40}$/.test(event.sender)) {
      return { valid: false, error: 'Invalid EVM sender address' };
    }

    if (event.target_chain === 'evm' && !/^0x[0-9a-fA-F]{40}$/.test(event.recipient)) {
      return { valid: false, error: 'Invalid EVM recipient address' };
    }

    // 检查 nonce
    if (!event.nonce || event.nonce === '0') {
      return { valid: false, error: 'Invalid nonce' };
    }

    // 检查跨链方向
    if (event.source_chain === event.target_chain) {
      return { valid: false, error: 'Source and target chain must be different' };
    }

    // 检查 ID 不重复
    if (this.leafMap.has(event.id)) {
      return { valid: false, error: 'Event already processed (duplicate nonce/tx)' };
    }

    return { valid: true };
  }

  /**
   * 获取当前 Merkle 根
   */
  getRoot(): string | null {
    return this.currentRoot ? '0x' + this.currentRoot.toString('hex') : null;
  }

  /**
   * 获取池中事件数量
   */
  getPoolSize(): number {
    return this.eventBuffer.length;
  }

  /**
   * 获取事件
   */
  getEvent(eventId: string): BridgeEvent | undefined {
    return this.eventBuffer.find((e) => e.id === eventId);
  }

  // ── 内部方法 ──

  private rebuildTree(): void {
    const leaves = this.eventBuffer.map((event) => computeLeaf(event));
    const { root, layers } = buildMerkleTree(leaves);
    this.currentRoot = root;
    this.currentLayers = layers;
  }
}
