// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

// Interface for GMX V2
interface IGMXV2Router {
    struct SwapParams {
        address receiver;
        address callbackContract;
        address uiFeeReceiver;
        address market;
        address initialCollateralToken;
        uint256 initialCollateralDeltaAmount;
        address[] swapPath;
        uint256 minOutputAmount;
        uint256 sizeDeltaUsd;
        uint256 acceptablePrice;
        uint256 executionFee;
        uint256 callbackGasLimit;
        uint256 referralCode;
        bytes32[] priceImpactDiffUsd;
    }

    function swap(SwapParams memory params) external payable returns (bytes32);
    
    function cancelOrder(bytes32 orderKey) external;
}

interface IGMXV2Callback {
    function afterSwapExecution(
        bytes32 orderKey,
        address marketAddress,
        address initialCollateralToken,
        address[] memory swapPath,
        uint256 initialCollateralDeltaAmount,
        uint256 minOutputAmount,
        uint256 outputAmount,
        uint256 executionFee
    ) external;

    function afterSwapCancellation(
        bytes32 orderKey,
        address marketAddress,
        address initialCollateralToken,
        address[] memory swapPath,
        uint256 initialCollateralDeltaAmount,
        uint256 minOutputAmount,
        uint256 executionFee
    ) external;
}

// Interface for Uniswap V2
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
 * @title GMX V2 Arbitrage Bot
 * @notice Contract for arbitrage between GMX V2 and other DEXs
 * @dev Uses GMX V2's two-step execution model
 */
contract GMXArbitrageur is Ownable, ReentrancyGuard, IGMXV2Callback {
    using SafeERC20 for IERC20;

    // Events
    event ArbitrageStarted(
        bytes32 indexed orderKey,
        address indexed user,
        address borrowToken,
        uint256 borrowAmount,
        address targetToken,
        address gmxMarket,
        uint256 executionFee
    );
    event GMXSwapExecuted(
        bytes32 indexed orderKey,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );
    event UniswapSwapExecuted(
        bytes32 indexed orderKey,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );
    event ProfitTaken(bytes32 indexed orderKey, address token, uint256 profit);
    event OrderCancelled(bytes32 indexed orderKey);
    event SlippageUpdated(uint256 oldTolerance, uint256 newTolerance);
    event TokensRescued(address indexed token, uint256 amount);
    event ArbitrageFailed(bytes32 indexed orderKey, string reason);

    // Structure to store arbitrage data
    struct ArbitrageOrder {
        address user;
        address borrowToken;
        address targetToken;
        uint256 borrowAmount;
        uint256 minUniswapOut;
        bool executed;
        bool isActive;
    }

    // Constants
    uint256 public constant SLIPPAGE_DENOMINATOR = 10000;
    uint256 public constant MAX_SLIPPAGE = 1000; // 10%

    // Settings
    IGMXV2Router public immutable gmxV2Router;
    address public immutable uniswapRouter;
    uint256 public slippageTolerance = 50; // 0.5% in basis points

    // State
    mapping(bytes32 => ArbitrageOrder) public orders;

    constructor(address _gmxV2Router, address _uniswapRouter) Ownable(msg.sender) {
        require(_gmxV2Router != address(0), "Invalid GMX router");
        require(_uniswapRouter != address(0), "Invalid Uniswap router");
        
        gmxV2Router = IGMXV2Router(_gmxV2Router);
        uniswapRouter = _uniswapRouter;
    }

    /**
     * @notice Initiates an arbitrage order
     * @dev Requires pre-approval of tokens
     */
    function createArbitrageOrder(
        address borrowToken,
        uint256 borrowAmount,
        address targetToken,
        address gmxMarket,
        uint256 gmxMinOut,
        uint256 uniswapMinOut,
        uint256 executionFee,
        uint256 callbackGasLimit
    ) external payable nonReentrant {
        require(borrowToken != address(0), "Invalid borrow token");
        require(targetToken != address(0), "Invalid target token");
        require(borrowAmount > 0, "Invalid borrow amount");
        require(msg.value >= executionFee, "Insufficient ETH for execution");
        require(callbackGasLimit > 0, "Invalid callback gas limit");
        
        // Transfer tokens from user
        IERC20(borrowToken).safeTransferFrom(
            msg.sender,
            address(this),
            borrowAmount
        );

        // Create GMX order
        bytes32 orderKey = _createGmxOrder(
            borrowToken,
            borrowAmount,
            targetToken,
            gmxMarket,
            gmxMinOut,
            executionFee,
            callbackGasLimit
        );

        // Store order data
        orders[orderKey] = ArbitrageOrder({
            user: msg.sender,
            borrowToken: borrowToken,
            targetToken: targetToken,
            borrowAmount: borrowAmount,
            minUniswapOut: uniswapMinOut,
            executed: false,
            isActive: true
        });

        emit ArbitrageStarted(
            orderKey,
            msg.sender,
            borrowToken,
            borrowAmount,
            targetToken,
            gmxMarket,
            executionFee
        );
    }

    /**
     * @notice Creates GMX V2 swap order
     * @return orderKey Created order key
     */
    function _createGmxOrder(
        address borrowToken,
        uint256 borrowAmount,
        address targetToken,
        address gmxMarket,
        uint256 gmxMinOut,
        uint256 executionFee,
        uint256 callbackGasLimit
    ) internal returns (bytes32) {
        // Reset previous approval if exists
        IERC20(borrowToken).safeApprove(address(gmxV2Router), 0);
        IERC20(borrowToken).safeApprove(address(gmxV2Router), borrowAmount);

        address[] memory path = new address[](2);
        path[0] = borrowToken;
        path[1] = targetToken;

        IGMXV2Router.SwapParams memory params = IGMXV2Router.SwapParams({
            receiver: address(this),
            callbackContract: address(this),
            uiFeeReceiver: address(0),
            market: gmxMarket,
            initialCollateralToken: borrowToken,
            initialCollateralDeltaAmount: borrowAmount,
            swapPath: path,
            minOutputAmount: gmxMinOut,
            sizeDeltaUsd: 0,
            acceptablePrice: 0,
            executionFee: executionFee,
            callbackGasLimit: callbackGasLimit,
            referralCode: 0,
            priceImpactDiffUsd: new bytes32[](0)
        });

        return gmxV2Router.swap{value: executionFee}(params);
    }

    /**
     * @notice Callback executed after GMX order completion
     * @dev Called by GMX keeper
     */
    function afterSwapExecution(
        bytes32 orderKey,
        address /* marketAddress */,
        address /* initialCollateralToken */,
        address[] memory /* swapPath */,
        uint256 /* initialCollateralDeltaAmount */,
        uint256 /* minOutputAmount */,
        uint256 outputAmount,
        uint256 /* executionFee */
    ) external override {
        // Important: Verify caller is authorized
        require(msg.sender == address(gmxV2Router) || _isAuthorizedKeeper(msg.sender), "Unauthorized");
        
        ArbitrageOrder storage order = orders[orderKey];
        require(order.isActive, "Order not active");
        require(!order.executed, "Order already executed");
        
        // Attempt arbitrage execution
        try this.executeArbitrage(orderKey, order, outputAmount) {
            order.executed = true;
        } catch Error(string memory reason) {
            emit ArbitrageFailed(orderKey, reason);
            // Return received tokens to user
            IERC20(order.targetToken).safeTransfer(order.user, outputAmount);
            order.executed = true;
        } catch {
            emit ArbitrageFailed(orderKey, "Unknown error");
            // Return received tokens to user
            IERC20(order.targetToken).safeTransfer(order.user, outputAmount);
            order.executed = true;
        }
    }

    /**
     * @notice External arbitrage execution function (for try-catch)
     */
    function executeArbitrage(
        bytes32 orderKey,
        ArbitrageOrder memory order,
        uint256 gmxOutputAmount
    ) external {
        require(msg.sender == address(this), "Internal function only");
        _executeArbitrage(orderKey, order, gmxOutputAmount);
    }

    /**
     * @notice Executes second leg of arbitrage on Uniswap
     */
    function _executeArbitrage(
        bytes32 orderKey,
        ArbitrageOrder memory order,
        uint256 gmxOutputAmount
    ) internal {
        // Received target token from GMX
        emit GMXSwapExecuted(
            orderKey,
            order.borrowToken,
            order.targetToken,
            order.borrowAmount,
            gmxOutputAmount
        );

        // Convert back to original token on Uniswap
        uint256 uniswapOutput = _swapOnUniswap(
            order.targetToken,
            order.borrowToken,
            gmxOutputAmount,
            order.minUniswapOut
        );

        emit UniswapSwapExecuted(
            orderKey,
            order.targetToken,
            order.borrowToken,
            gmxOutputAmount,
            uniswapOutput
        );

        // Calculate and distribute profits
        _distributeProfit(orderKey, order, uniswapOutput);
    }

    /**
     * @notice Execute swap on Uniswap
     */
    function _swapOnUniswap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut
    ) internal returns (uint256) {
        // Reset previous approval
        IERC20(tokenIn).safeApprove(uniswapRouter, 0);
        IERC20(tokenIn).safeApprove(uniswapRouter, amountIn);
        
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint256 balanceBefore = IERC20(tokenOut).balanceOf(address(this));
        
        IUniswapV2Router(uniswapRouter).swapExactTokensForTokens(
            amountIn,
            minOut,
            path,
            address(this),
            block.timestamp + 300
        );
        
        uint256 balanceAfter = IERC20(tokenOut).balanceOf(address(this));
        require(balanceAfter > balanceBefore, "Swap failed");
        
        return balanceAfter - balanceBefore;
    }

    /**
     * @notice Profit distribution logic
     */
    function _distributeProfit(
        bytes32 orderKey,
        ArbitrageOrder memory order,
        uint256 finalAmount
    ) internal {
        if (finalAmount <= order.borrowAmount) {
            // No profit - return available funds to user
            IERC20(order.borrowToken).safeTransfer(order.user, finalAmount);
            return;
        }
        
        uint256 profit = finalAmount - order.borrowAmount;
        
        // Return initial capital to user
        IERC20(order.borrowToken).safeTransfer(order.user, order.borrowAmount);
        
        // Send profit to contract owner
        IERC20(order.borrowToken).safeTransfer(owner(), profit);
        
        emit ProfitTaken(orderKey, order.borrowToken, profit);
    }

    /**
     * @notice Callback for cancelled GMX orders
     */
    function afterSwapCancellation(
        bytes32 orderKey,
        address /* marketAddress */,
        address initialCollateralToken,
        address[] memory /* swapPath */,
        uint256 initialCollateralDeltaAmount,
        uint256 /* minOutputAmount */,
        uint256 /* executionFee */
    ) external override {
        require(msg.sender == address(gmxV2Router) || _isAuthorizedKeeper(msg.sender), "Unauthorized");
        
        ArbitrageOrder storage order = orders[orderKey];
        require(order.isActive, "Order not active");
        
        // Return funds to user
        IERC20(initialCollateralToken).safeTransfer(
            order.user, 
            initialCollateralDeltaAmount
        );
        
        order.isActive = false;
        emit OrderCancelled(orderKey);
    }

    /**
     * @notice Manual order cancellation
     * @dev Can be called when order takes too long
     */
    function cancelOrder(bytes32 orderKey) external {
        ArbitrageOrder storage order = orders[orderKey];
        require(order.user == msg.sender || msg.sender == owner(), "Not authorized");
        require(order.isActive, "Order not active");
        require(!order.executed, "Order already executed");
        
        gmxV2Router.cancelOrder(orderKey);
        order.isActive = false;
    }

    /**
     * @notice Authorized keeper check (stub)
     */
    function _isAuthorizedKeeper(address keeper) internal pure returns (bool) {
        // Should contain GMX keeper authorization logic
        // In production, obtain keeper list from GMX
        return false;
    }

    /**
     * @notice Get expected output from Uniswap
     */
    function getUniswapAmountOut(
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external view returns (uint256) {
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        
        uint256[] memory amounts = IUniswapV2Router(uniswapRouter).getAmountsOut(amountIn, path);
        return amounts[1];
    }

    /**
     * @notice Update slippage tolerance
     */
    function setSlippageTolerance(uint256 _tolerance) external onlyOwner {
        require(_tolerance <= MAX_SLIPPAGE, "Slippage too high");
        
        uint256 oldTolerance = slippageTolerance;
        slippageTolerance = _tolerance;
        emit SlippageUpdated(oldTolerance, _tolerance);
    }

    /**
     * @notice Rescue tokens from contract
     */
    function rescueTokens(address token) external onlyOwner {
        uint256 amount;
        if (token == address(0)) {
            amount = address(this).balance;
            payable(owner()).transfer(amount);
        } else {
            amount = IERC20(token).balanceOf(address(this));
            IERC20(token).safeTransfer(owner(), amount);
        }
        emit TokensRescued(token, amount);
    }

    /**
     * @notice Get order information
     */
    function getOrderInfo(bytes32 orderKey) external view returns (ArbitrageOrder memory) {
        return orders[orderKey];
    }

    receive() external payable {}
}