'use client';

import History from '@/components/History';
import WalletConnect from '@/components/WalletConnect';

export default function HistoryPage() {
  return (
    <div className="space-y-8">
      {/* Hero Section */}
      <div className="text-center space-y-4">
        <h2 className="text-4xl font-bold bg-gradient-to-r from-white via-primary-200 to-primary-400 bg-clip-text text-transparent">
          Transaction History
        </h2>
        <p className="text-dark-400 max-w-2xl mx-auto">
          View all your cross-chain bridge transactions and their current status.
        </p>
      </div>

      {/* Wallet Connection */}
      <div className="flex justify-center">
        <WalletConnect />
      </div>

      {/* History */}
      <div className="max-w-4xl mx-auto">
        <History />
      </div>
    </div>
  );
}
