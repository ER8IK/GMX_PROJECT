// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@aave/core-v3/contracts/flashloan/interfaces/IPool.sol";

// Custom Errors
error InsufficientEthForExecution();
error Unauthorized();
error InvalidInitiator();
error InsufficientRepayment(uint256 expected, uint256 available);
error SlippageTooHigh(uint256 maxAllowed, uint256 provided);
error FlashLoanRepaymentFailed();

/**
 * @title GMX V2 Router Interface
 * @notice Interface for GMX V2 ExchangeRouter with SwapParams struct
 */
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

    function swap(SwapParams memory params) external payable;
}

/**
 * @title Uniswap V2 Router Interface
 * @notice Interface for Uniswap V2 compatible exchanges
 */
interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/**
 * @title GMX Arbitrageur V2
 * @notice Contract for executing arbitrage between GMX V2 and Uniswap
 * @dev Uses Aave flash loans for capital efficiency
 */
contract GMXArbitrageur is Ownable {
    using SafeERC20 for IERC20;
    
    // Events
    event ArbitrageStarted(
        address indexed borrowToken,
        uint256 borrowAmount,
        address indexed targetToken,
        address gmxMarket,
        uint256 executionFee
    );
    event GMXSwapExecuted(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );
    event UniswapSwapExecuted(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );
    event ProfitTaken(address indexed token, uint256 profit);
    event SlippageUpdated(uint256 oldTolerance, uint256 newTolerance);
    event TokensRescued(address indexed token, uint256 amount);
    event ExecutionFailed(string reason);
    
    /// @notice Aave V3 Lending Pool address
    IPool public immutable aavePool;
    
    /// @notice GMX V2 ExchangeRouter address
    IGMXV2Router public immutable gmxV2Router;
    
    /// @notice Uniswap V2 compatible router address
    address public immutable uniswapRouter;
    
    /// @notice Slippage tolerance in basis points (1 = 0.01%)
    uint256 public slippageTolerance = 50; // Default 0.5%

    constructor(
        address _aavePool,
        address _gmxV2Router,
        address _uniswapRouter
    ) {
        aavePool = IPool(_aavePool);
        gmxV2Router = IGMXV2Router(_gmxV2Router);
        uniswapRouter = _uniswapRouter;
    }

    /**
     * @notice Initiate arbitrage with flash loan
     * @dev Emits ArbitrageStarted event
     */
    function startArbitrage(
        address borrowToken,
        uint256 borrowAmount,
        address targetToken,
        address gmxMarket,
        uint256 gmxMinOut,
        uint256 uniswapMinOut,
        uint256 executionFee
    ) external onlyOwner {
        if (address(this).balance < executionFee) {
            revert InsufficientEthForExecution();
        }
        
        address[] memory assets = new address[](1);
        assets[0] = borrowToken;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = borrowAmount;
        
        bytes memory params = abi.encode(
            borrowToken,
            targetToken,
            borrowAmount,
            gmxMinOut,
            uniswapMinOut,
            gmxMarket,
            executionFee
        );
        
        aavePool.flashLoan(
            address(this),
            assets,
            amounts,
            new uint256[](1),
            address(this),
            params,
            0
        );
        
        emit ArbitrageStarted(
            borrowToken,
            borrowAmount,
            targetToken,
            gmxMarket,
            executionFee
        );
    }

    /**
     * @notice Aave flash loan callback
     * @dev Emits swap events and ProfitTaken if successful
     */
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (msg.sender != address(aavePool)) {
            revert Unauthorized();
        }
        if (initiator != address(this)) {
            revert InvalidInitiator();
        }
        
        (
            address borrowToken,
            address targetToken,
            uint256 borrowAmount,
            uint256 gmxMinOut,
            uint256 uniswapMinOut,
            address gmxMarket,
            uint256 executionFee
        ) = abi.decode(params, (address, address, uint256, uint256, uint256, address, uint256));
        
        try this._swapOnGMX(
            borrowToken, 
            targetToken, 
            borrowAmount, 
            gmxMinOut, 
            gmxMarket, 
            executionFee
        ) {
            uint256 targetAmount = IERC20(targetToken).balanceOf(address(this));
            
            try this._swapOnUniswap(
                targetToken, 
                borrowToken, 
                targetAmount, 
                uniswapMinOut
            ) {
                uint256 debt = amounts[0] + premiums[0];
                uint256 finalBalance = IERC20(borrowToken).balanceOf(address(this));
                
                if (finalBalance < debt) {
                    revert InsufficientRepayment(debt, finalBalance);
                }
                
                IERC20(borrowToken).approve(address(aavePool), debt);
                
                if (finalBalance > debt) {
                    uint256 profit = finalBalance - debt;
                    IERC20(borrowToken).transfer(owner(), profit);
                    emit ProfitTaken(borrowToken, profit);
                }
                return true;
            } catch Error(string memory reason) {
                emit ExecutionFailed(reason);
                return false;
            }
        } catch Error(string memory reason) {
            emit ExecutionFailed(reason);
            return false;
        }
    }

    /**
     * @notice Execute swap on GMX V2
     * @dev Emits GMXSwapExecuted event
     */
    function _swapOnGMX(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address gmxMarket,
        uint256 executionFee
    ) external {
        // Only callable from within contract
        require(msg.sender == address(this), "Internal call only");
        
        IERC20(tokenIn).approve(address(gmxV2Router), amountIn);
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        
        IGMXV2Router.SwapParams memory swapParams = IGMXV2Router.SwapParams({
            receiver: address(this),
            callbackContract: address(0),
            uiFeeReceiver: address(0),
            market: gmxMarket,
            initialCollateralToken: tokenIn,
            initialCollateralDeltaAmount: amountIn,
            swapPath: path,
            minOutputAmount: minOut,
            sizeDeltaUsd: 0,
            acceptablePrice: 0,
            executionFee: executionFee,
            callbackGasLimit: 0,
            referralCode: 0,
            priceImpactDiffUsd: new bytes32[](0)
        });
        
        gmxV2Router.swap{value: executionFee}(swapParams);
        
        uint256 amountOut = IERC20(tokenOut).balanceOf(address(this));
        emit GMXSwapExecuted(tokenIn, tokenOut, amountIn, amountOut);
    }

    /**
     * @notice Execute swap on Uniswap
     * @dev Emits UniswapSwapExecuted event
     */
    function _swapOnUniswap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut
    ) external {
        // Only callable from within contract
        require(msg.sender == address(this), "Internal call only");
        
        IERC20(tokenIn).approve(uniswapRouter, amountIn);
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
        
        uint256 amountOut = IERC20(tokenOut).balanceOf(address(this)) - balanceBefore;
        emit UniswapSwapExecuted(tokenIn, tokenOut, amountIn, amountOut);
    }

    /**
     * @notice Update slippage tolerance
     * @dev Emits SlippageUpdated event
     */
    function setSlippageTolerance(uint256 _tolerance) external onlyOwner {
        if (_tolerance >= 1000) {
            revert SlippageTooHigh(1000, _tolerance);
        }
        
        uint256 oldTolerance = slippageTolerance;
        slippageTolerance = _tolerance;
        emit SlippageUpdated(oldTolerance, _tolerance);
    }

    /**
     * @notice Rescue tokens or ETH
     * @dev Emits TokensRescued event
     */
    function rescueTokens(address token) external onlyOwner {
        uint256 amount;
        if (token == address(0)) {
            amount = address(this).balance;
            payable(owner()).transfer(amount);
        } else {
            amount = IERC20(token).balanceOf(address(this));
            IERC20(token).transfer(owner(), amount);
        }
        emit TokensRescued(token, amount);
    }

    receive() external payable {}
}