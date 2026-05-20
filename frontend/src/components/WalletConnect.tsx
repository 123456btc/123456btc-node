'use client';

import { useWallet } from '@/hooks/useWallet';
import { Chain } from '@/stores/bridge';

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

export default function WalletConnect() {
  const {
    wallet,
    isPhantomAvailable,
    isMetaMaskAvailable,
    connectPhantom,
    connectMetaMask,
    disconnect,
  } = useWallet();

  const formatAddress = (address: string | null) => {
    if (!address) return '';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  const renderWalletButton = (chain: Chain) => {
    const isConnected = wallet[chain].connected;
    const address = wallet[chain].address;
    const isSolana = chain === 'solana';
    const isAvailable = isSolana ? isPhantomAvailable : isMetaMaskAvailable;

    if (isConnected) {
      return (
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-2 bg-dark-700 rounded-lg px-4 py-2">
            <span className="text-lg">{chainIcons[chain]}</span>
            <span className="text-sm text-dark-300">{chainNames[chain]}</span>
            <span className="text-sm font-mono text-primary-400">
              {formatAddress(address)}
            </span>
          </div>
          <button
            onClick={() => disconnect(chain)}
            className="text-sm text-dark-400 hover:text-red-400 transition-colors"
          >
            Disconnect
          </button>
        </div>
      );
    }

    return (
      <button
        onClick={() => {
          if (isSolana) {
            connectPhantom();
          } else {
            connectMetaMask(chain);
          }
        }}
        disabled={!isAvailable}
        className={`flex items-center space-x-2 px-4 py-2 rounded-lg transition-all duration-300 ${
          isAvailable
            ? 'bg-dark-700 hover:bg-dark-600 border border-dark-600 hover:border-primary-500/50'
            : 'bg-dark-800 text-dark-500 cursor-not-allowed'
        }`}
      >
        <span className="text-lg">{chainIcons[chain]}</span>
        <span className="text-sm">
          {isAvailable
            ? `Connect ${chainNames[chain]}`
            : `${isSolana ? 'Phantom' : 'MetaMask'} not installed`}
        </span>
      </button>
    );
  };

  return (
    <div className="glass-card p-6">
      <h3 className="text-lg font-semibold text-white mb-4">Connect Wallets</h3>
      <div className="space-y-3">
        {renderWalletButton('solana')}
        {renderWalletButton('ethereum')}
        {renderWalletButton('bnb')}
      </div>

      {/* Installation hints */}
      {(!isPhantomAvailable || !isMetaMaskAvailable) && (
        <div className="mt-4 p-3 bg-dark-700/50 rounded-lg">
          <p className="text-xs text-dark-400">
            {!isPhantomAvailable && (
              <>
                Install{' '}
                <a
                  href="https://phantom.app/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary-400 hover:underline"
                >
                  Phantom Wallet
                </a>{' '}
                for Solana.{' '}
              </>
            )}
            {!isMetaMaskAvailable && (
              <>
                Install{' '}
                <a
                  href="https://metamask.io/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary-400 hover:underline"
                >
                  MetaMask
                </a>{' '}
                for Ethereum/BNB Chain.
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
