'use client';

import { useBridge } from '@/hooks/useBridge';
import { BridgeTransaction, Chain } from '@/stores/bridge';

const chainNames: Record<Chain, string> = {
  solana: 'Solana',
  ethereum: 'Ethereum',
  bnb: 'BNB Chain',
};

const chainIcons: Record<Chain, string> = {
  solana: '◎',
  ethereum: 'Ξ',
  bnb: 'BNB',
};

const statusColors: Record<BridgeTransaction['status'], string> = {
  pending: 'text-yellow-400 bg-yellow-400/10',
  processing: 'text-blue-400 bg-blue-400/10',
  completed: 'text-green-400 bg-green-400/10',
  failed: 'text-red-400 bg-red-400/10',
};

const statusLabels: Record<BridgeTransaction['status'], string> = {
  pending: 'Pending',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
};

export default function History() {
  const { transactions, getTransactionStats } = useBridge();
  const stats = getTransactionStats();

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  const formatAddress = (address: string | undefined) => {
    if (!address) return '-';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  const renderTransactionRow = (tx: BridgeTransaction) => {
    return (
      <div
        key={tx.id}
        className="flex items-center justify-between p-4 bg-dark-800/50 rounded-xl hover:bg-dark-700/50 transition-colors"
      >
        <div className="flex items-center space-x-4">
          {/* Chain Icons */}
          <div className="flex items-center space-x-1">
            <span className="text-lg">{chainIcons[tx.fromChain]}</span>
            <svg
              className="w-4 h-4 text-dark-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M14 5l7 7m0 0l-7 7m7-7H3"
              />
            </svg>
            <span className="text-lg">{chainIcons[tx.toChain]}</span>
          </div>

          {/* Transaction Info */}
          <div>
            <div className="text-sm font-medium text-white">
              {tx.amount} BBT
            </div>
            <div className="text-xs text-dark-400">
              {chainNames[tx.fromChain]} → {chainNames[tx.toChain]}
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-4">
          {/* Time */}
          <div className="text-right">
            <div className="text-xs text-dark-400">{formatTime(tx.timestamp)}</div>
            {tx.txHash && (
              <a
                href={`https://explorer.solana.com/tx/${tx.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary-400 hover:underline"
              >
                {formatAddress(tx.txHash)}
              </a>
            )}
          </div>

          {/* Status */}
          <span
            className={`px-3 py-1 rounded-full text-xs font-medium ${
              statusColors[tx.status]
            }`}
          >
            {statusLabels[tx.status]}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="glass-card p-6">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-xl font-semibold text-white">Transaction History</h3>
        <div className="flex items-center space-x-4 text-sm">
          <span className="text-dark-400">
            Total: <span className="text-white">{stats.total}</span>
          </span>
          <span className="text-green-400">
            Completed: {stats.completed}
          </span>
          <span className="text-yellow-400">
            Pending: {stats.pending}
          </span>
          {stats.failed > 0 && (
            <span className="text-red-400">Failed: {stats.failed}</span>
          )}
        </div>
      </div>

      {/* Transaction List */}
      {transactions.length === 0 ? (
        <div className="text-center py-12">
          <svg
            className="w-16 h-16 text-dark-600 mx-auto mb-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
            />
          </svg>
          <p className="text-dark-400">No transactions yet</p>
          <p className="text-sm text-dark-500 mt-1">
            Your bridge transactions will appear here
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {transactions.map(renderTransactionRow)}
        </div>
      )}

      {/* Info Box */}
      <div className="mt-6 p-4 bg-dark-700/30 rounded-xl">
        <div className="flex items-start space-x-3">
          <svg
            className="w-5 h-5 text-primary-400 mt-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <div>
            <p className="text-sm text-dark-300">
              Transactions are processed on-chain. Completion times vary based on
              network congestion.
            </p>
            <p className="text-xs text-dark-400 mt-1">
              Click on transaction hash to view on block explorer.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
