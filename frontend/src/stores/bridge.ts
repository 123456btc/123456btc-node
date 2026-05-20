import { create } from 'zustand';

export type Chain = 'solana' | 'ethereum' | 'bnb';

export interface BridgeTransaction {
  id: string;
  fromChain: Chain;
  toChain: Chain;
  amount: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  txHash?: string;
  timestamp: number;
  error?: string;
}

interface WalletState {
  solana: {
    connected: boolean;
    address: string | null;
    balance: string;
  };
  ethereum: {
    connected: boolean;
    address: string | null;
    balance: string;
  };
  bnb: {
    connected: boolean;
    address: string | null;
    balance: string;
  };
}

interface BridgeState {
  // Wallet state
  wallet: WalletState;

  // Bridge form state
  fromChain: Chain;
  toChain: Chain;
  amount: string;

  // Transaction state
  isProcessing: boolean;
  transactions: BridgeTransaction[];
  currentTx: BridgeTransaction | null;

  // Error state
  error: string | null;

  // Actions
  setFromChain: (chain: Chain) => void;
  setToChain: (chain: Chain) => void;
  setAmount: (amount: string) => void;
  connectSolana: (address: string) => void;
  connectEthereum: (address: string) => void;
  connectBnb: (address: string) => void;
  disconnectWallet: (chain: Chain) => void;
  updateBalance: (chain: Chain, balance: string) => void;
  startBridge: () => void;
  updateTransactionStatus: (id: string, status: BridgeTransaction['status'], error?: string) => void;
  addTransaction: (tx: BridgeTransaction) => void;
  setError: (error: string | null) => void;
  clearError: () => void;
}

const initialWalletState: WalletState = {
  solana: { connected: false, address: null, balance: '0' },
  ethereum: { connected: false, address: null, balance: '0' },
  bnb: { connected: false, address: null, balance: '0' },
};

export const useBridgeStore = create<BridgeState>((set, get) => ({
  // Initial state
  wallet: initialWalletState,
  fromChain: 'solana',
  toChain: 'ethereum',
  amount: '',
  isProcessing: false,
  transactions: [],
  currentTx: null,
  error: null,

  // Chain selection
  setFromChain: (chain) => {
    const { toChain } = get();
    if (chain === toChain) {
      set({ fromChain: chain, toChain: get().fromChain });
    } else {
      set({ fromChain: chain });
    }
  },

  setToChain: (chain) => {
    const { fromChain } = get();
    if (chain === fromChain) {
      set({ toChain: chain, fromChain: get().toChain });
    } else {
      set({ toChain: chain });
    }
  },

  // Amount
  setAmount: (amount) => set({ amount }),

  // Wallet connections
  connectSolana: (address) =>
    set((state) => ({
      wallet: {
        ...state.wallet,
        solana: { connected: true, address, balance: '0' },
      },
    })),

  connectEthereum: (address) =>
    set((state) => ({
      wallet: {
        ...state.wallet,
        ethereum: { connected: true, address, balance: '0' },
      },
    })),

  connectBnb: (address) =>
    set((state) => ({
      wallet: {
        ...state.wallet,
        bnb: { connected: true, address, balance: '0' },
      },
    })),

  disconnectWallet: (chain) =>
    set((state) => ({
      wallet: {
        ...state.wallet,
        [chain]: { connected: false, address: null, balance: '0' },
      },
    })),

  updateBalance: (chain, balance) =>
    set((state) => ({
      wallet: {
        ...state.wallet,
        [chain]: { ...state.wallet[chain], balance },
      },
    })),

  // Bridge operations
  startBridge: () => {
    const { fromChain, toChain, amount, wallet } = get();

    // Validation
    if (!amount || parseFloat(amount) <= 0) {
      set({ error: 'Please enter a valid amount' });
      return;
    }

    if (!wallet[fromChain].connected) {
      set({ error: `Please connect your ${fromChain} wallet` });
      return;
    }

    const newTx: BridgeTransaction = {
      id: `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      fromChain,
      toChain,
      amount,
      status: 'pending',
      timestamp: Date.now(),
    };

    set({
      isProcessing: true,
      currentTx: newTx,
      transactions: [newTx, ...get().transactions],
      error: null,
    });
  },

  updateTransactionStatus: (id, status, error) =>
    set((state) => ({
      transactions: state.transactions.map((tx) =>
        tx.id === id ? { ...tx, status, error } : tx
      ),
      currentTx:
        state.currentTx?.id === id
          ? { ...state.currentTx, status, error }
          : state.currentTx,
      isProcessing: status === 'pending' || status === 'processing',
    })),

  addTransaction: (tx) =>
    set((state) => ({
      transactions: [tx, ...state.transactions],
    })),

  setError: (error) => set({ error }),
  clearError: () => set({ error: null }),
}));
