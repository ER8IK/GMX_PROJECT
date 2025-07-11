// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@aave/core-v3/contracts/flashloan/interfaces/IPool.sol";

interface IGMXRouter {
    function swap(
        address[] memory _path,
        uint256 _amountIn,
        uint256 _minOut,
        address _receiver
    ) external;
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

contract GMXArbitrageur is Ownable {
    using SafeERC20 for IERC20;
    // @notice Aave V3 Lending Pool on Arbitrum
    IPool public immutable aavePool;
    // @notice GMX Router contract address
    address public immutable gmxRouter;
    // @notice Uniswap V2/Sushiswap Router address
    address public immutable uniswapRouter;
    // @notice Default slippage tolerance (0.5%)
    uint256 public slippageTolerance = 50; // 0.5% in basis points

    /**
     * @notice Contract constructor
     * @param _aavePool Aave V3 Lending Pool address
     * @param _gmxRouter GMX Router address
     * @param _uniswapRouter Uniswap V2 Router address
     */
    constructor(
        address _aavePool,
        address _gmxRouter,
        address _uniswapRouter
    ) {
        aavePool = IPool(_aavePool);
        gmxRouter = _gmxRouter;
        uniswapRouter = _uniswapRouter;
    }

    /**
     * @notice Initiate flash loan for arbitrage
     * @param borrowToken Token to borrow (e.g., USDC)
     * @param borrowAmount Amount to borrow
     * @param targetToken Token to arbitrage (e.g., WETH)
     * @param gmxMinOut Minimum output expected from GMX swap
     * @param uniswapMinOut Minimum output expected from Uniswap swap
     */
    function startArbitrage(
        address borrowToken,
        uint256 borrowAmount,
        address targetToken,
        uint256 gmxMinOut,
        uint256 uniswapMinOut
    ) external onlyOwner {
        // Prepare flash loan parameters
        address[] memory assets = new address[](1);
        assets[0] = borrowToken;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = borrowAmount;
        // Encode arbitrage parameters for callback
        bytes memory params = abi.encode(
            borrowToken,
            targetToken,
            borrowAmount,
            gmxMinOut,
            uniswapMinOut
        );
        // Initiate flash loan
        aavePool.flashLoan(
            address(this),
            assets,
            amounts,
            new uint256[](1),
            address(this),
            params,
            0
        );
    }

    /**
     * @notice Aave flash loan callback
     * @dev Executes arbitrage logic
     */
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == address(aavePool), "Unauthorized");
        require(initiator == address(this), "Invalid initiator");
        // Decode parameters
        (
            address borrowToken,
            address targetToken,
            uint256 borrowAmount,
            uint256 gmxMinOut,
            uint256 uniswapMinOut
        ) = abi.decode(params, (address, address, uint256, uint256, uint256));
        // 1. Swap borrowedToken to targetToken on GMX
        _swapOnGMX(borrowToken, targetToken, borrowAmount, gmxMinOut);
        // 2. Swap targetToken back to borrowedToken on Uniswap
        uint256 targetAmount = IERC20(targetToken).balanceOf(address(this));
        _swapOnUniswap(targetToken, borrowToken, targetAmount, uniswapMinOut);
        // 3. Calculate debt (loan + premium)
        uint256 debt = borrowAmount + premiums[0];
        uint256 finalBalance = IERC20(borrowToken).balanceOf(address(this));
        require(finalBalance >= debt, "Insufficient funds to repay loan");
        // 4. Repay flash loan
        IERC20(borrowToken).approve(address(aavePool), debt);
        // 5. Transfer profit to owner
        if (finalBalance > debt) {
            IERC20(borrowToken).transfer(owner(), finalBalance - debt);
        }
        return true;
    }

    /**
     * @notice Internal function to swap tokens on GMX
     * @dev Uses GMX Router for swaps
     */
    function _swapOnGMX(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut
    ) private {
        IERC20(tokenIn).approve(gmxRouter, amountIn);
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        IGMXRouter(gmxRouter).swap(path, amountIn, minOut, address(this));
    }

    /**
     * @notice Internal function to swap tokens on Uniswap
     * @dev Uses Uniswap V2-compatible Router
     */
    function _swapOnUniswap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut
    ) private {
        IERC20(tokenIn).approve(uniswapRouter, amountIn);
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        IUniswapV2Router(uniswapRouter).swapExactTokensForTokens(
            amountIn,
            minOut,
            path,
            address(this),
            block.timestamp + 300
        );
    }

    /**
     * @notice Update slippage tolerance
     * @param _tolerance New slippage tolerance in basis points (1 = 0.01%)
     */
    function setSlippageTolerance(uint256 _tolerance) external onlyOwner {
        require(_tolerance < 1000, "Slippage too high");
        slippageTolerance = _tolerance;
    }

    /**
     * @notice Rescue tokens accidentally sent to contract
     * @param token Token address to recover
     */
    function rescueTokens(address token) external onlyOwner {
        IERC20(token).transfer(owner(), IERC20(token).balanceOf(address(this)));
    }
}
