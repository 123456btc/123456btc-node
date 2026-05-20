'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useBridgeStore, Chain, BridgeTransaction } from '@/stores/bridge';
import { useWallet } from './useWallet';

// Simulated bridge contract addresses
const BRIDGE_CONTRACTS: Record<Chain, string> = {
  solana: 'BBridgeSo111111111111111111111111111111111111',
  ethereum: '0x1234567890123456789012345678901234567890',
  bnb: '0x0987654321098765432109876543210987654321',
};

export function useBridge() {
  const {
    fromChain,
    toChain,
    amount,
    isProcessing,
    transactions,
    currentTx,
    error,
    setFromChain,
    setToChain,
    setAmount,
    startBridge,
    updateTransactionStatus,
    setError,
    clearError,
  } = useBridgeStore();

  const { wallet, switchNetwork } = useWallet();
  const processingRef = useRef(false);

  // Execute bridge transaction
  const executeBridge = useCallback(async () => {
    if (processingRef.current) return;

    // Validation
    if (!amount || parseFloat(amount) <= 0) {
      setError('Please enter a valid amount');
      return;
    }

    if (!wallet[fromChain].connected) {
      setError(`Please connect your ${fromChain} wallet`);
      return;
    }

    const balance = parseFloat(wallet[fromChain].balance);
    if (balance < parseFloat(amount)) {
      setError('Insufficient balance');
      return;
    }

    processingRef.current = true;
    startBridge();

    try {
      // Simulate bridge process
      const txId = `tx_${Date.now()}`;

      // Step 1: Pending
      updateTransactionStatus(txId, 'pending');

      // Step 2: Switch network if needed (for EVM chains)
      if (fromChain !== 'solana') {
        await switchNetwork(fromChain);
      }

      // Step 3: Processing (simulate transaction)
      await new Promise((resolve) => setTimeout(resolve, 2000));
      updateTransactionStatus(txId, 'processing');

      // Step 4: Simulate bridge contract interaction
      const simulatedTxHash = `0x${Array.from({ length: 64 }, () =>
        Math.floor(Math.random() * 16).toString(16)
      ).join('')}`;

      // Step 5: Wait for confirmation (simulated)
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Step 6: Completed
      updateTransactionStatus(txId, 'completed');

      console.log('Bridge completed:', {
        from: fromChain,
        to: toChain,
        amount,
        txHash: simulatedTxHash,
        bridgeContract: BRIDGE_CONTRACTS[fromChain],
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Bridge transaction failed';
      setError(errorMessage);
      if (currentTx) {
        updateTransactionStatus(currentTx.id, 'failed', errorMessage);
      }
    } finally {
      processingRef.current = false;
    }
  }, [
    fromChain,
    toChain,
    amount,
    wallet,
    startBridge,
    updateTransactionStatus,
    switchNetwork,
    setError,
    currentTx,
  ]);

  // Auto-clear errors after 5 seconds
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => {
        clearError();
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [error, clearError]);

  // Get estimated fees
  const getEstimatedFee = useCallback(() => {
    const amountNum = parseFloat(amount) || 0;
    const feePercentage = 0.001; // 0.1%
    const minFee = 0.01;

    return Math.max(amountNum * feePercentage, minFee);
  }, [amount]);

  // Get estimated time
  const getEstimatedTime = useCallback(() => {
    if (fromChain === 'solana' || toChain === 'solana') {
      return '~30 seconds';
    }
    return '~2 minutes';
  }, [fromChain, toChain]);

  // Check if bridge is valid
  const isValidBridge = useCallback(() => {
    return (
      fromChain !== toChain &&
      parseFloat(amount) > 0 &&
      wallet[fromChain].connected
    );
  }, [fromChain, toChain, amount, wallet]);

  // Format address for display
  const formatAddress = useCallback((address: string | null) => {
    if (!address) return '';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }, []);

  // Get transaction by ID
  const getTransaction = useCallback(
    (id: string): BridgeTransaction | undefined => {
      return transactions.find((tx) => tx.id === id);
    },
    [transactions]
  );

  // Get recent transactions
  const getRecentTransactions = useCallback(
    (limit: number = 10): BridgeTransaction[] => {
      return transactions.slice(0, limit);
    },
    [transactions]
  );

  // Get transaction stats
  const getTransactionStats = useCallback(() => {
    const completed = transactions.filter((tx) => tx.status === 'completed').length;
    const pending = transactions.filter(
      (tx) => tx.status === 'pending' || tx.status === 'processing'
    ).length;
    const failed = transactions.filter((tx) => tx.status === 'failed').length;

    return { total: transactions.length, completed, pending, failed };
  }, [transactions]);

  return {
    // State
    fromChain,
    toChain,
    amount,
    isProcessing,
    transactions,
    currentTx,
    error,
    wallet,

    // Actions
    setFromChain,
    setToChain,
    setAmount,
    executeBridge,
    clearError,

    // Helpers
    getEstimatedFee,
    getEstimatedTime,
    isValidBridge,
    formatAddress,
    getTransaction,
    getRecentTransactions,
    getTransactionStats,
  };
}
