#!/usr/bin/env tsx
/**
 * 部署后更新代码中的 Program ID
 * Usage: npx tsx scripts/update-program-ids.ts <subscription_escrow_id> [blindbox_id] [bridge_id]
 */
import fs from 'fs';
import path from 'path';

const [,, subId, blindId, bridgeId] = process.argv;

if (!subId) {
    console.error('Usage: npx tsx scripts/update-program-ids.ts <subscription_escrow_id> [blindbox_id] [bridge_id]');
    process.exit(1);
}

// 更新 IDL
const idlPath = path.join(process.cwd(), 'src/infra/chain/idl/subscription_escrow.json');
const idl = JSON.parse(fs.readFileSync(idlPath, 'utf-8'));
idl.metadata = idl.metadata || {};
idl.metadata.address = subId;
fs.writeFileSync(idlPath, JSON.stringify(idl, null, 2));
console.log('Updated IDL metadata.address:', subId);

// 更新 Anchor.toml（如有）
const anchorToml = path.join(process.cwd(), 'contracts/Anchor.toml');
if (fs.existsSync(anchorToml) && (subId || blindId || bridgeId)) {
    let content = fs.readFileSync(anchorToml, 'utf-8');
    if (subId) content = content.replace(/subscription_escrow = "[^"]+"/g, `subscription_escrow = "${subId}"`);
    if (blindId) content = content.replace(/blindbox_escrow = "[^"]+"/g, `blindbox_escrow = "${blindId}"`);
    if (bridgeId) content = content.replace(/bridge = "[^"]+"/g, `bridge = "${bridgeId}"`);
    fs.writeFileSync(anchorToml, content);
    console.log('Updated contracts/Anchor.toml');
}

// 输出配置命令
console.log('');
console.log('=== Next steps ===');
console.log(`123456btc-node config --set escrow_program_id=${subId}`);
console.log(`export BBT_ESCROW_PROGRAM_ID=${subId}`);
