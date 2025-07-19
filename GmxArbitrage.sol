// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

// Updated GMX V2 interfaces based on actual implementation
interface IGMXV2ExchangeRouter {
    struct CreateOrderParams {
        CreateOrderParamsAddresses addresses;
        CreateOrderParamsNumbers numbers;
        OrderType orderType;
        DecreasePositionSwapType decreasePositionSwapType;
        bool isLong;
        bool shouldUnwrapNativeToken;
        bytes32 referralCode;
    }

    struct CreateOrderParamsAddresses {
        address receiver;
        address callbackContract;
        address uiFeeReceiver;
        address market;
        address initialCollateralToken;
        address[] swapPath;
    }

    struct CreateOrderParamsNumbers {
        uint256 sizeDeltaUsd;
        uint256 initialCollateralDeltaAmount;
        uint256 triggerPrice;
        uint256 acceptablePrice;
        uint256 executionFee;
        uint256 callbackGasLimit;
        uint256 minOutputAmount;
    }

    enum OrderType {
        MarketSwap,
        LimitSwap,
        MarketIncrease,
        LimitIncrease,
        MarketDecrease,
        LimitDecrease,
        StopLossDecrease,
        Liquidation
    }

    enum DecreasePositionSwapType {
        NoSwap,
        SwapPnlTokenToCollateralToken,
        SwapCollateralTokenToPnlToken
    }

    function createOrder(CreateOrderParams calldata params) external payable returns (bytes32);
    function cancelOrder(bytes32 key) external;
}

interface IGMXV2OrderCallbackReceiver {
    function afterOrderExecution(bytes32 key, Order calldata order, EventLogData calldata eventData) external;
    function afterOrderCancellation(bytes32 key, Order calldata order, EventLogData calldata eventData) external;
    function afterOrderFrozen(bytes32 key, Order calldata order, EventLogData calldata eventData) external;
}

struct Order {
    OrderAddresses addresses;
    OrderNumbers numbers;
    OrderFlags flags;
}

struct OrderAddresses {
    address account;
    address receiver;
    address callbackContract;
    address uiFeeReceiver;
    address market;
    address initialCollateralToken;
    address[] swapPath;
}

struct OrderNumbers {
    uint256 orderType;
    uint256 decreasePositionSwapType;
    uint256 sizeDeltaUsd;
    uint256 initialCollateralDeltaAmount;
    uint256 triggerPrice;
    uint256 acceptablePrice;
    uint256 executionFee;
    uint256 callbackGasLimit;
    uint256 minOutputAmount;
    uint256 updatedAtBlock;
}

struct OrderFlags {
    bool isLong;
    bool shouldUnwrapNativeToken;
    bool isFrozen;
}

struct EventLogData {
    AddressItems addressItems;
    UintItems uintItems;
    IntItems intItems;
    BoolItems boolItems;
    Bytes32Items bytes32Items;
    BytesItems bytesItems;
    StringItems stringItems;
}

struct AddressItems {
    AddressKeyValue[] items;
    AddressArrayKeyValue[] arrayItems;
}

struct UintItems {
    UintKeyValue[] items;
    UintArrayKeyValue[] arrayItems;
}

struct IntItems {
    IntKeyValue[] items;
    IntArrayKeyValue[] arrayItems;
}

struct BoolItems {
    BoolKeyValue[] items;
    BoolArrayKeyValue[] arrayItems;
}

struct Bytes32Items {
    Bytes32KeyValue[] items;
    Bytes32ArrayKeyValue[] arrayItems;
}

struct BytesItems {
    BytesKeyValue[] items;
    BytesArrayKeyValue[] arrayItems;
}

struct StringItems {
    StringKeyValue[] items;
    StringArrayKeyValue[] arrayItems;
}

struct AddressKeyValue {
    string key;
    address value;
}

struct AddressArrayKeyValue {
    string key;
    address[] value;
}

struct UintKeyValue {
    string key;
    uint256 value;
}

struct UintArrayKeyValue {
    string key;
    uint256[] value;
}

struct IntKeyValue {
    string key;
    int256 value;
}

struct IntArrayKeyValue {
    string key;
    int256[] value;
}

struct BoolKeyValue {
    string key;
    bool value;
}

struct BoolArrayKeyValue {
    string key;
    bool[] value;
}

struct Bytes32KeyValue {
    string key;
    bytes32 value;
}

struct Bytes32ArrayKeyValue {
    string key;
    bytes32[] value;
}

struct BytesKeyValue {
    string key;
    bytes value;
}

struct BytesArrayKeyValue {
    string key;
    bytes[] value;
}

struct StringKeyValue {
    string key;
    string value;
}

// Uniswap V2 interface
interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
    
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external view returns (uint256[] memory amounts);
}

/**
 * @title Improved GMX V2 Arbitrage Bot
 * @notice Enhanced arbitrage contract with profitability checks and better error handling
 */
contract ImprovedGMXArbitrageur is Ownable, ReentrancyGuard, IGMXV2OrderCallbackReceiver {
    using SafeERC20 for IERC20;

    // Events
    event ArbitrageStarted(
        bytes32 indexed orderKey,
        address indexed user,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 expectedProfit
    );
    event ArbitrageCompleted(
        bytes32 indexed orderKey,
        uint256 actualProfit
    );
    event ArbitrageFailed(
        bytes32 indexed orderKey,
        string reason
    );
    event ProfitabilityCheckFailed(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        string reason
    );

    struct ArbitrageData {
        address user;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minProfitBps; // Minimum profit in basis points
        bool isActive;
        bool isExecuted;
    }

    // Constants
    uint256 public constant MAX_SLIPPAGE_BPS = 1000; // 10%
    uint256 public constant MIN_PROFIT_BPS = 10; // 0.1% minimum profit
    uint256 public constant DEADLINE_EXTENSION = 300; // 5 minutes

    // Contract addresses
    IGMXV2ExchangeRouter public immutable gmxRouter;
    IUniswapV2Router public immutable uniswapRouter;
    
    // Settings
    uint256 public slippageToleranceBps = 50; // 0.5%
    mapping(address => bool) public authorizedKeepers;
    mapping(bytes32 => ArbitrageData) public arbitrageOrders;

    modifier onlyAuthorizedKeeper() {
        require(
            msg.sender == address(gmxRouter) || authorizedKeepers[msg.sender],
            "Unauthorized keeper"
        );
        _;
    }

    constructor(
        address _gmxRouter,
        address _uniswapRouter,
        address[] memory _authorizedKeepers
    ) {
        require(_gmxRouter != address(0), "Invalid GMX router");
        require(_uniswapRouter != address(0), "Invalid Uniswap router");
        
        gmxRouter = IGMXV2ExchangeRouter(_gmxRouter);
        uniswapRouter = IUniswapV2Router(_uniswapRouter);
        
        // Set authorized keepers
        for (uint256 i = 0; i < _authorizedKeepers.length; i++) {
            authorizedKeepers[_authorizedKeepers[i]] = true;
        }
    }

    /**
     * @notice Check if arbitrage is profitable before execution
     */
    function checkProfitability(
        address tokenIn,
        address tokenOut,
        address market,
        uint256 amountIn,
        uint256 minProfitBps
    ) public view returns (bool isProfitable, uint256 estimatedProfitBps, string memory reason) {
        try this.getGMXAmountOut(market, tokenIn, tokenOut, amountIn) returns (uint256 gmxOut) {
            try this.getUniswapAmountOut(tokenOut, tokenIn, gmxOut) returns (uint256 uniswapOut) {
                if (uniswapOut <= amountIn) {
                    return (false, 0, "No profit possible");
                }
                
                uint256 profit = uniswapOut - amountIn;
                uint256 profitBps = (profit * 10000) / amountIn;
                
                if (profitBps < minProfitBps) {
                    return (false, profitBps, "Profit below minimum");
                }
                
                return (true, profitBps, "Profitable");
            } catch {
                return (false, 0, "Uniswap quote failed");
            }
        } catch {
            return (false, 0, "GMX quote failed");
        }
    }

    /**
     * @notice Create arbitrage order with profitability check
     */
    function createArbitrageOrder(
        address tokenIn,
        address tokenOut,
        address market,
        uint256 amountIn,
        uint256 minProfitBps,
        uint256 executionFee,
        uint256 callbackGasLimit
    ) external payable nonReentrant {
        require(tokenIn != address(0) && tokenOut != address(0), "Invalid tokens");
        require(amountIn > 0, "Invalid amount");
        require(minProfitBps >= MIN_PROFIT_BPS, "Profit threshold too low");
        require(msg.value >= executionFee, "Insufficient execution fee");
        require(callbackGasLimit >= 200000, "Callback gas too low");

        // Check profitability
        (bool profitable, uint256 expectedProfitBps, string memory reason) = 
            checkProfitability(tokenIn, tokenOut, market, amountIn, minProfitBps);
            
        if (!profitable) {
            emit ProfitabilityCheckFailed(tokenIn, tokenOut, amountIn, reason);
            revert("Arbitrage not profitable");
        }

        // Transfer tokens
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // Create GMX order
        bytes32 orderKey = _createGMXOrder(
            tokenIn,
            tokenOut,
            market,
            amountIn,
            executionFee,
            callbackGasLimit
        );

        // Store arbitrage data
        arbitrageOrders[orderKey] = ArbitrageData({
            user: msg.sender,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minProfitBps: minProfitBps,
            isActive: true,
            isExecuted: false
        });

        emit ArbitrageStarted(
            orderKey,
            msg.sender,
            tokenIn,
            tokenOut,
            amountIn,
            expectedProfitBps
        );
    }

    /**
     * @notice Create GMX order with proper parameters
     */
    function _createGMXOrder(
        address tokenIn,
        address tokenOut,
        address market,
        uint256 amountIn,
        uint256 executionFee,
        uint256 callbackGasLimit
    ) internal returns (bytes32) {
        // Approve tokens
        IERC20(tokenIn).safeApprove(address(gmxRouter), amountIn);

        address[] memory swapPath = new address[](2);
        swapPath[0] = tokenIn;
        swapPath[1] = tokenOut;

        uint256 minOut = _calculateMinOut(tokenIn, tokenOut, amountIn);

        IGMXV2ExchangeRouter.CreateOrderParams memory params = IGMXV2ExchangeRouter.CreateOrderParams({
            addresses: IGMXV2ExchangeRouter.CreateOrderParamsAddresses({
                receiver: address(this),
                callbackContract: address(this),
                uiFeeReceiver: address(0),
                market: market,
                initialCollateralToken: tokenIn,
                swapPath: swapPath
            }),
            numbers: IGMXV2ExchangeRouter.CreateOrderParamsNumbers({
                sizeDeltaUsd: 0,
                initialCollateralDeltaAmount: amountIn,
                triggerPrice: 0,
                acceptablePrice: 0,
                executionFee: executionFee,
                callbackGasLimit: callbackGasLimit,
                minOutputAmount: minOut
            }),
            orderType: IGMXV2ExchangeRouter.OrderType.MarketSwap,
            decreasePositionSwapType: IGMXV2ExchangeRouter.DecreasePositionSwapType.NoSwap,
            isLong: false,
            shouldUnwrapNativeToken: false,
            referralCode: bytes32(0)
        });

        return gmxRouter.createOrder{value: executionFee}(params);
    }

    /**
     * @notice Calculate minimum output with slippage protection
     */
    function _calculateMinOut(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) internal view returns (uint256) {
        try this.getUniswapAmountOut(tokenIn, tokenOut, amountIn) returns (uint256 expectedOut) {
            return expectedOut * (10000 - slippageToleranceBps) / 10000;
        } catch {
            return 0; // Let GMX handle the minimum
        }
    }

    /**
     * @notice GMX order execution callback
     */
    function afterOrderExecution(
        bytes32 key,
        Order calldata order,
        EventLogData calldata eventData
    ) external override onlyAuthorizedKeeper {
        ArbitrageData storage arbitrage = arbitrageOrders[key];
        require(arbitrage.isActive, "Order not active");
        require(!arbitrage.isExecuted, "Already executed");

        arbitrage.isExecuted = true;

        // Extract output amount from event data
        uint256 outputAmount = _extractOutputAmount(eventData);
        if (outputAmount == 0) {
            emit ArbitrageFailed(key, "Cannot extract output amount");
            return;
        }

        // Execute second leg on Uniswap
        try this.executeUniswapSwap(key, arbitrage, outputAmount) {
            // Success handled in executeUniswapSwap
        } catch Error(string memory reason) {
            emit ArbitrageFailed(key, reason);
            // Return tokens to user
            IERC20(arbitrage.tokenOut).safeTransfer(arbitrage.user, outputAmount);
        } catch {
            emit ArbitrageFailed(key, "Unknown error in Uniswap swap");
            IERC20(arbitrage.tokenOut).safeTransfer(arbitrage.user, outputAmount);
        }
    }

    /**
     * @notice Execute Uniswap swap (external for try-catch)
     */
    function executeUniswapSwap(
        bytes32 orderKey,
        ArbitrageData memory arbitrage,
        uint256 amountIn
    ) external {
        require(msg.sender == address(this), "Internal only");

        // Calculate minimum output
        uint256 minOut = _calculateUniswapMinOut(
            arbitrage.tokenOut,
            arbitrage.tokenIn,
            amountIn
        );

        // Execute swap
        uint256 finalAmount = _executeUniswapSwap(
            arbitrage.tokenOut,
            arbitrage.tokenIn,
            amountIn,
            minOut
        );

        // Distribute profits
        _handleProfitDistribution(orderKey, arbitrage, finalAmount);
    }

    /**
     * @notice Calculate minimum Uniswap output
     */
    function _calculateUniswapMinOut(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) internal view returns (uint256) {
        try this.getUniswapAmountOut(tokenIn, tokenOut, amountIn) returns (uint256 expectedOut) {
            return expectedOut * (10000 - slippageToleranceBps) / 10000;
        } catch {
            return arbitrageOrders[msg.sig].amountIn; // At least break even
        }
    }

    /**
     * @notice Execute Uniswap swap
     */
    function _executeUniswapSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut
    ) internal returns (uint256) {
        IERC20(tokenIn).safeApprove(address(uniswapRouter), amountIn);

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint256[] memory amounts = uniswapRouter.swapExactTokensForTokens(
            amountIn,
            minOut,
            path,
            address(this),
            block.timestamp + DEADLINE_EXTENSION
        );

        return amounts[1];
    }

    /**
     * @notice Handle profit distribution
     */
    function _handleProfitDistribution(
        bytes32 orderKey,
        ArbitrageData memory arbitrage,
        uint256 finalAmount
    ) internal {
        if (finalAmount <= arbitrage.amountIn) {
            // No profit or loss - return available amount
            IERC20(arbitrage.tokenIn).safeTransfer(arbitrage.user, finalAmount);
            emit ArbitrageFailed(orderKey, "No profit generated");
            return;
        }

        uint256 profit = finalAmount - arbitrage.amountIn;
        uint256 profitBps = (profit * 10000) / arbitrage.amountIn;

        if (profitBps < arbitrage.minProfitBps) {
            // Profit below threshold - return all to user
            IERC20(arbitrage.tokenIn).safeTransfer(arbitrage.user, finalAmount);
            emit ArbitrageFailed(orderKey, "Profit below minimum threshold");
            return;
        }

        // Distribute profit: 80% to user, 20% to protocol
        uint256 userProfit = profit * 80 / 100;
        uint256 protocolProfit = profit - userProfit;

        // Transfer original amount + user profit share
        IERC20(arbitrage.tokenIn).safeTransfer(
            arbitrage.user,
            arbitrage.amountIn + userProfit
        );

        // Transfer protocol profit
        IERC20(arbitrage.tokenIn).safeTransfer(owner(), protocolProfit);

        emit ArbitrageCompleted(orderKey, profitBps);
    }

    /**
     * @notice Extract output amount from GMX event data
     */
    function _extractOutputAmount(EventLogData calldata eventData) 
        internal 
        pure 
        returns (uint256) 
    {
        // Look for output amount in event data
        for (uint256 i = 0; i < eventData.uintItems.items.length; i++) {
            if (keccak256(bytes(eventData.uintItems.items[i].key)) == keccak256("outputAmount")) {
                return eventData.uintItems.items[i].value;
            }
        }
        return 0;
    }

    /**
     * @notice GMX order cancellation callback
     */
    function afterOrderCancellation(
        bytes32 key,
        Order calldata order,
        EventLogData calldata /* eventData */
    ) external override onlyAuthorizedKeeper {
        ArbitrageData storage arbitrage = arbitrageOrders[key];
        require(arbitrage.isActive, "Order not active");

        arbitrage.isActive = false;

        // Return tokens to user
        IERC20(arbitrage.tokenIn).safeTransfer(
            arbitrage.user,
            arbitrage.amountIn
        );

        emit ArbitrageFailed(key, "Order cancelled");
    }

    /**
     * @notice GMX order frozen callback
     */
    function afterOrderFrozen(
        bytes32 key,
        Order calldata /* order */,
        EventLogData calldata /* eventData */
    ) external override onlyAuthorizedKeeper {
        emit ArbitrageFailed(key, "Order frozen");
    }

    /**
     * @notice Get GMX quote (implement based on GMX SDK)
     */
    function getGMXAmountOut(
        address market,
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external view returns (uint256) {
        // This should integrate with GMX's pricing contracts
        // For now, return a placeholder - implement based on GMX documentation
        revert("GMX quote not implemented");
    }

    /**
     * @notice Get Uniswap quote
     */
    function getUniswapAmountOut(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external view returns (uint256) {
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        
        uint256[] memory amounts = uniswapRouter.getAmountsOut(amountIn, path);
        return amounts[1];
    }

    /**
     * @notice Manual order cancellation
     */
    function cancelOrder(bytes32 orderKey) external {
        ArbitrageData storage arbitrage = arbitrageOrders[orderKey];
        require(
            arbitrage.user == msg.sender || msg.sender == owner(),
            "Not authorized"
        );
        require(arbitrage.isActive, "Order not active");
        require(!arbitrage.isExecuted, "Order already executed");

        gmxRouter.cancelOrder(orderKey);
    }

    /**
     * @notice Admin functions
     */
    function setSlippageTolerance(uint256 _slippageBps) external onlyOwner {
        require(_slippageBps <= MAX_SLIPPAGE_BPS, "Slippage too high");
        slippageToleranceBps = _slippageBps;
    }

    function setAuthorizedKeeper(address keeper, bool authorized) external onlyOwner {
        authorizedKeepers[keeper] = authorized;
    }

    function rescueTokens(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) {
            payable(owner()).transfer(amount);
        } else {
            IERC20(token).safeTransfer(owner(), amount);
        }
    }

    receive() external payable {}
}