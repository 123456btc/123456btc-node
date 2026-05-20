'use client';

import { useState } from 'react';
import Bridge from '@/components/Bridge';
import WalletConnect from '@/components/WalletConnect';
import History from '@/components/History';

export default function Home() {
  const [activeTab, setActiveTab] = useState<'bridge' | 'history'>('bridge');

  return (
    <div className="space-y-8">
      {/* Hero Section */}
      <div className="text-center space-y-4">
        <h2 className="text-4xl font-bold bg-gradient-to-r from-white via-primary-200 to-primary-400 bg-clip-text text-transparent">
          Cross-Chain BBT Bridge
        </h2>
        <p className="text-dark-400 max-w-2xl mx-auto">
          Transfer your BBT tokens seamlessly across Solana, Ethereum, and BNB Chain.
          Fast, secure, and decentralized.
        </p>
      </div>

      {/* Wallet Connection */}
      <div className="flex justify-center">
        <WalletConnect />
      </div>

      {/* Tab Navigation */}
      <div className="flex justify-center space-x-2">
        <button
          onClick={() => setActiveTab('bridge')}
          className={`px-6 py-2 rounded-lg font-medium transition-all duration-300 ${
            activeTab === 'bridge'
              ? 'bg-primary-500 text-white shadow-lg shadow-primary-500/25'
              : 'bg-dark-800 text-dark-300 hover:bg-dark-700'
          }`}
        >
          Bridge
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={`px-6 py-2 rounded-lg font-medium transition-all duration-300 ${
            activeTab === 'history'
              ? 'bg-primary-500 text-white shadow-lg shadow-primary-500/25'
              : 'bg-dark-800 text-dark-300 hover:bg-dark-700'
          }`}
        >
          History
        </button>
      </div>

      {/* Main Content */}
      <div className="max-w-2xl mx-auto">
        {activeTab === 'bridge' ? <Bridge /> : <History />}
      </div>

      {/* Stats Section */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl mx-auto">
        <div className="glass-card p-6 text-center">
          <div className="text-3xl font-bold text-primary-400">3</div>
          <div className="text-dark-400 mt-1">Supported Chains</div>
        </div>
        <div className="glass-card p-6 text-center">
          <div className="text-3xl font-bold text-primary-400">&lt;30s</div>
          <div className="text-dark-400 mt-1">Transfer Time</div>
        </div>
        <div className="glass-card p-6 text-center">
          <div className="text-3xl font-bold text-primary-400">0.1%</div>
          <div className="text-dark-400 mt-1">Bridge Fee</div>
        </div>
      </div>
    </div>
  );
}
