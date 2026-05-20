'use client';

import { useCallback, useEffect } from 'react';
import { useBridgeStore, Chain } from '@/stores/bridge';

// Type declarations for wallet providers
interface SolanaProvider {
  isPhantom?: boolean;
  connect: () => Promise<{ publicKey: { toString: () => string } }>;
  disconnect: () => Promise<void>;
  on: (event: string, callback: (...args: unknown[]) => void) => void;
  publicKey?: { toString: () => string };
}

interface EthereumProvider {
  isMetaMask?: boolean;
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on: (event: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (event: string, callback: (...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    solana?: SolanaProvider;
    ethereum?: EthereumProvider;
  }
}

export function useWallet() {
  const {
    wallet,
    connectSolana,
    connectEthereum,
    connectBnb,
    disconnectWallet,
    updateBalance,
    setError,
  } = useBridgeStore();

  // Check if wallets are available
  const isPhantomAvailable = typeof window !== 'undefined' && !!window.solana?.isPhantom;
  const isMetaMaskAvailable = typeof window !== 'undefined' && !!window.ethereum?.isMetaMask;

  // Connect to Phantom (Solana)
  const connectPhantom = useCallback(async () => {
    if (!window.solana?.isPhantom) {
      setError('Phantom wallet not found. Please install it.');
      return;
    }

    try {
      const response = await window.solana.connect();
      const address = response.publicKey.toString();
      connectSolana(address);

      // Fetch balance (simplified - in production, use proper RPC)
      updateBalance('solana', '0');
    } catch (err) {
      setError('Failed to connect to Phantom wallet');
      console.error('Phantom connection error:', err);
    }
  }, [connectSolana, updateBalance, setError]);

  // Connect to MetaMask (Ethereum/BNB)
  const connectMetaMask = useCallback(
    async (chain: Chain) => {
      if (!window.ethereum?.isMetaMask) {
        setError('MetaMask not found. Please install it.');
        return;
      }

      try {
        const accounts = (await window.ethereum.request({
          method: 'eth_requestAccounts',
        })) as string[];

        if (accounts.length > 0) {
          const address = accounts[0];

          if (chain === 'ethereum') {
            connectEthereum(address);
          } else if (chain === 'bnb') {
            connectBnb(address);
          }

          // Fetch balance (simplified - in production, use proper RPC)
          updateBalance(chain, '0');
        }
      } catch (err) {
        setError(`Failed to connect to MetaMask for ${chain}`);
        console.error('MetaMask connection error:', err);
      }
    },
    [connectEthereum, connectBnb, updateBalance, setError]
  );

  // Switch network (for MetaMask)
  const switchNetwork = useCallback(
    async (chain: Chain) => {
      if (!window.ethereum) return;

      const chainConfigs: Record<string, { chainId: string; chainName: string; rpcUrls: string[] }> = {
        ethereum: {
          chainId: '0x1',
          chainName: 'Ethereum Mainnet',
          rpcUrls: ['https://mainnet.infura.io/v3/'],
        },
        bnb: {
          chainId: '0x38',
          chainName: 'BNB Smart Chain',
          rpcUrls: ['https://bsc-dataseed.binance.org/'],
        },
      };

      const config = chainConfigs[chain];
      if (!config) return;

      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: config.chainId }],
        });
      } catch (err: unknown) {
        // Chain not added, try to add it
        if ((err as { code?: number }).code === 4902) {
          try {
            await window.ethereum!.request({
              method: 'wallet_addEthereumChain',
              params: [
                {
                  chainId: config.chainId,
                  chainName: config.chainName,
                  rpcUrls: config.rpcUrls,
                },
              ],
            });
          } catch (addError) {
            setError(`Failed to add ${chain} network`);
            console.error('Add chain error:', addError);
          }
        }
      }
    },
    [setError]
  );

  // Disconnect wallet
  const disconnect = useCallback(
    async (chain: Chain) => {
      if (chain === 'solana' && window.solana) {
        await window.solana.disconnect();
      }
      disconnectWallet(chain);
    },
    [disconnectWallet]
  );

  // Listen for account changes
  useEffect(() => {
    if (window.ethereum) {
      const handleAccountsChanged = (...args: unknown[]) => {
        const accounts = args[0] as string[];
        if (!Array.isArray(accounts) || accounts.length === 0) {
          // User disconnected
          disconnectWallet('ethereum');
          disconnectWallet('bnb');
        } else {
          // Account changed
          const address = accounts[0];
          if (wallet.ethereum.connected) {
            connectEthereum(address);
          }
          if (wallet.bnb.connected) {
            connectBnb(address);
          }
        }
      };

      window.ethereum.on('accountsChanged', handleAccountsChanged);

      return () => {
        window.ethereum?.removeListener('accountsChanged', handleAccountsChanged);
      };
    }
  }, [wallet.ethereum.connected, wallet.bnb.connected, connectEthereum, connectBnb, disconnectWallet]);

  return {
    wallet,
    isPhantomAvailable,
    isMetaMaskAvailable,
    connectPhantom,
    connectMetaMask,
    switchNetwork,
    disconnect,
  };
}
