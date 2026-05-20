'use client';

import { useState } from 'react';
import { useBridge } from '@/hooks/useBridge';
import { Chain } from '@/stores/bridge';

const chains: { id: Chain; name: string; icon: string }[] = [
  { id: 'solana', name: 'Solana', icon: '◎' },
  { id: 'ethereum', name: 'Ethereum', icon: 'Ξ' },
  { id: 'bnb', name: 'BNB Chain', icon: 'BNB' },
];

export default function Bridge() {
  const {
    fromChain,
    toChain,
    amount,
    isProcessing,
    error,
    wallet,
    setFromChain,
    setToChain,
    setAmount,
    executeBridge,
    clearError,
    getEstimatedFee,
    getEstimatedTime,
    isValidBridge,
  } = useBridge();

  const [showDetails, setShowDetails] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await executeBridge();
  };

  const handleSwapChains = () => {
    const tempFrom = fromChain;
    setFromChain(toChain);
    setToChain(tempFrom);
  };

  const fee = getEstimatedFee();
  const estimatedTime = getEstimatedTime();
  const isValid = isValidBridge();

  return (
    <div className="glass-card p-6">
      <h3 className="text-xl font-semibold text-white mb-6">Bridge Tokens</h3>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* From Chain */}
        <div className="space-y-2">
          <label className="text-sm text-dark-400">From</label>
          <div className="grid grid-cols-3 gap-2">
            {chains.map((chain) => (
              <button
                key={chain.id}
                type="button"
                onClick={() => setFromChain(chain.id)}
                className={`flex items-center justify-center space-x-2 p-3 rounded-xl transition-all duration-300 ${
                  fromChain === chain.id
                    ? 'bg-primary-500/20 border-2 border-primary-500 text-primary-400'
                    : 'bg-dark-700 border-2 border-transparent text-dark-300 hover:bg-dark-600'
                }`}
              >
                <span className="text-lg">{chain.icon}</span>
                <span className="text-sm font-medium">{chain.name}</span>
              </button>
            ))}
          </div>
          {wallet[fromChain].connected && (
            <p className="text-xs text-dark-400">
              Balance: {wallet[fromChain].balance} BBT
            </p>
          )}
        </div>

        {/* Swap Button */}
        <div className="flex justify-center">
          <button
            type="button"
            onClick={handleSwapChains}
            className="p-2 rounded-full bg-dark-700 hover:bg-dark-600 border border-dark-600 hover:border-primary-500/50 transition-all duration-300"
          >
            <svg
              className="w-6 h-6 text-dark-300"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"
              />
            </svg>
          </button>
        </div>

        {/* To Chain */}
        <div className="space-y-2">
          <label className="text-sm text-dark-400">To</label>
          <div className="grid grid-cols-3 gap-2">
            {chains.map((chain) => (
              <button
                key={chain.id}
                type="button"
                onClick={() => setToChain(chain.id)}
                className={`flex items-center justify-center space-x-2 p-3 rounded-xl transition-all duration-300 ${
                  toChain === chain.id
                    ? 'bg-primary-500/20 border-2 border-primary-500 text-primary-400'
                    : 'bg-dark-700 border-2 border-transparent text-dark-300 hover:bg-dark-600'
                }`}
              >
                <span className="text-lg">{chain.icon}</span>
                <span className="text-sm font-medium">{chain.name}</span>
              </button>
            ))}
          </div>
          {wallet[toChain].connected && (
            <p className="text-xs text-dark-400">
              Balance: {wallet[toChain].balance} BBT
            </p>
          )}
        </div>

        {/* Amount Input */}
        <div className="space-y-2">
          <label className="text-sm text-dark-400">Amount</label>
          <div className="relative">
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.0"
              step="0.000001"
              min="0"
              className="input-dark w-full pr-16 text-2xl font-semibold"
            />
            <button
              type="button"
              onClick={() => {
                if (wallet[fromChain].connected) {
                  setAmount(wallet[fromChain].balance);
                }
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-primary-400 hover:text-primary-300"
            >
              MAX
            </button>
          </div>
        </div>

        {/* Transaction Details */}
        <div className="bg-dark-700/50 rounded-xl p-4">
          <button
            type="button"
            onClick={() => setShowDetails(!showDetails)}
            className="flex items-center justify-between w-full text-sm text-dark-300"
          >
            <span>Transaction Details</span>
            <svg
              className={`w-4 h-4 transition-transform ${
                showDetails ? 'rotate-180' : ''
              }`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>

          {showDetails && (
            <div className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-dark-400">Bridge Fee (0.1%)</span>
                <span className="text-white">{fee.toFixed(6)} BBT</span>
              </div>
              <div className="flex justify-between">
                <span className="text-dark-400">Estimated Time</span>
                <span className="text-white">{estimatedTime}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-dark-400">You will receive</span>
                <span className="text-white font-semibold">
                  {amount ? (parseFloat(amount) - fee).toFixed(6) : '0'} BBT
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Error Message */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/50 rounded-xl p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-red-400">{error}</p>
              <button
                type="button"
                onClick={clearError}
                className="text-red-400 hover:text-red-300"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          </div>
        )}

        {/* Submit Button */}
        <button
          type="submit"
          disabled={!isValid || isProcessing}
          className={`w-full btn-primary py-4 text-lg font-semibold ${
            !isValid || isProcessing
              ? 'opacity-50 cursor-not-allowed'
              : ''
          }`}
        >
          {isProcessing ? (
            <div className="flex items-center justify-center space-x-2">
              <svg
                className="animate-spin h-5 w-5 text-white"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span>Processing...</span>
            </div>
          ) : !wallet[fromChain].connected ? (
            `Connect ${fromChain.charAt(0).toUpperCase() + fromChain.slice(1)} Wallet`
          ) : (
            'Bridge Tokens'
          )}
        </button>
      </form>
    </div>
  );
}
