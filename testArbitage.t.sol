// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {GMXArbitrageur} from "../src/GMXArbitrageur.sol";

contract GMXArbitrageurTest is Test {
    GMXArbitrageur arbitrageur;
    
    address gmxRouter = makeAddr("GMX_Router");
    address uniswapRouter = makeAddr("Uniswap_Router");
    
    address owner = makeAddr("owner");
    address user = makeAddr("user");
    address keeper = makeAddr("keeper");
    
    address borrowToken = makeAddr("borrowToken");
    address targetToken = makeAddr("targetToken");
    address market = makeAddr("market");
    
    uint256 borrowAmount = 100 ether;
    uint256 gmxMinOut = 90 ether;
    uint256 uniswapMinOut = 95 ether;
    uint256 executionFee = 0.1 ether;
    uint256 callbackGasLimit = 200000;

    function setUp() public {
        vm.startPrank(owner);
        arbitrageur = new GMXArbitrageur(gmxRouter, uniswapRouter);
        vm.stopPrank();
    }

    function testCreateArbitrageOrder() public {
        vm.startPrank(user);
        
        vm.mockCall(
            borrowToken,
            abi.encodeWithSignature("approve(address,uint256)", address(arbitrageur), borrowAmount),
            abi.encode(true)
        );
        vm.mockCall(
            borrowToken,
            abi.encodeWithSignature("transferFrom(address,address,uint256)", user, address(arbitrageur), borrowAmount),
            abi.encode(true)
        );
        
        vm.deal(user, executionFee);
        
        vm.expectEmit(true, true, false, true);
        emit GMXArbitrageur.ArbitrageStarted(
            bytes32(0), // will match any orderKey
            user,
            borrowToken,
            borrowAmount,
            targetToken,
            market,
            executionFee
        );
        
        arbitrageur.createArbitrageOrder{value: executionFee}(
            borrowToken,
            borrowAmount,
            targetToken,
            market,
            gmxMinOut,
            uniswapMinOut,
            executionFee,
            callbackGasLimit
        );
        
        assertEq(address(arbitrageur).balance, executionFee);
        vm.stopPrank();
    }

    function testSuccessfulArbitrage() public {
        bytes32 orderKey = _createSampleOrder();
        uint256 gmxOutput = 95 ether;
        uint256 uniswapOutput = 100 ether;
        
        _mockTokenTransfers(gmxOutput, uniswapOutput);
        
        vm.expectEmit(true, true, true, true);
        emit GMXArbitrageur.GMXSwapExecuted(
            orderKey,
            borrowToken,
            targetToken,
            borrowAmount,
            gmxOutput
        );
        
        vm.expectEmit(true, true, true, true);
        emit GMXArbitrageur.UniswapSwapExecuted(
            orderKey,
            targetToken,
            borrowToken,
            gmxOutput,
            uniswapOutput
        );
        
        vm.expectEmit(true, true, false, true);
        emit GMXArbitrageur.ProfitTaken(
            orderKey,
            borrowToken,
            uniswapOutput - borrowAmount
        );
        
        vm.startPrank(gmxRouter);
        arbitrageur.afterSwapExecution(
            orderKey,
            market,
            borrowToken,
            _getPath(),
            borrowAmount,
            gmxMinOut,
            gmxOutput,
            executionFee
        );
        vm.stopPrank();
        
        GMXArbitrageur.ArbitrageOrder memory order = arbitrageur.getOrderInfo(orderKey);
        assertTrue(order.executed);
    }

    function testFailedArbitrage() public {
        bytes32 orderKey = _createSampleOrder();
        uint256 gmxOutput = 95 ether;
        uint256 uniswapOutput = 85 ether;
        
        _mockTokenTransfers(gmxOutput, uniswapOutput);
        
        vm.expectEmit(true, false, false, true);
        emit GMXArbitrageur.ArbitrageFailed(orderKey, "Insufficient output amount");
        
        vm.startPrank(gmxRouter);
        arbitrageur.afterSwapExecution(
            orderKey,
            market,
            borrowToken,
            _getPath(),
            borrowAmount,
            gmxMinOut,
            gmxOutput,
            executionFee
        );
        vm.stopPrank();
        
        vm.mockCall(
            targetToken,
            abi.encodeWithSignature("balanceOf(address)", address(arbitrageur)),
            abi.encode(0)
        );
    }

    function testSetSlippageTolerance() public {
        uint256 newSlippage = 100;
        
        vm.expectEmit(true, true, false, true);
        emit GMXArbitrageur.SlippageUpdated(50, newSlippage);
        
        vm.prank(owner);
        arbitrageur.setSlippageTolerance(newSlippage);
        
        assertEq(arbitrageur.slippageTolerance(), newSlippage);
    }

    function testOrderCancellation() public {
        bytes32 orderKey = _createSampleOrder();
        
        vm.expectEmit(true, false, false, true);
        emit GMXArbitrageur.OrderCancelled(orderKey);
        
        vm.startPrank(gmxRouter);
        arbitrageur.afterSwapCancellation(
            orderKey,
            market,
            borrowToken,
            _getPath(),
            borrowAmount,
            gmxMinOut,
            executionFee
        );
        vm.stopPrank();
        
        GMXArbitrageur.ArbitrageOrder memory order = arbitrageur.getOrderInfo(orderKey);
        assertFalse(order.isActive);
    }

    function testManualCancellation() public {
        bytes32 orderKey = _createSampleOrder();
        
        vm.mockCall(
            gmxRouter,
            abi.encodeWithSignature("cancelOrder(bytes32)", orderKey),
            abi.encode()
        );
        
        vm.expectEmit(true, false, false, true);
        emit GMXArbitrageur.OrderCancelled(orderKey);
        
        vm.prank(user);
        arbitrageur.cancelOrder(orderKey);
        
        GMXArbitrageur.ArbitrageOrder memory order = arbitrageur.getOrderInfo(orderKey);
        assertFalse(order.isActive);
    }

    function testRescueTokens() public {
        address testToken = makeAddr("testToken");
        uint256 amount = 10 ether;
        
        vm.mockCall(
            testToken,
            abi.encodeWithSignature("balanceOf(address)", address(arbitrageur)),
            abi.encode(amount)
        );
        
        vm.mockCall(
            testToken,
            abi.encodeWithSignature("transfer(address,uint256)", owner, amount),
            abi.encode(true)
        );
        
        vm.expectEmit(true, false, false, true);
        emit GMXArbitrageur.TokensRescued(testToken, amount);
        
        vm.prank(owner);
        arbitrageur.rescueTokens(testToken);
    }

    function _createSampleOrder() private returns (bytes32) {
        vm.startPrank(user);
        vm.deal(user, executionFee);
        
        bytes32 orderKey = keccak256(abi.encode(
            address(arbitrageur),
            block.timestamp,
            user,
            borrowToken,
            targetToken,
            borrowAmount
        ));
        
        vm.mockCall(
            gmxRouter,
            abi.encodeWithSignature("swap((address,address,address,address,address,uint256,address[],uint256,uint256,uint256,uint256,uint256,uint256,bytes32[]))"),
            abi.encode(orderKey)
        );
        
        arbitrageur.createArbitrageOrder{value: executionFee}(
            borrowToken,
            borrowAmount,
            targetToken,
            market,
            gmxMinOut,
            uniswapMinOut,
            executionFee,
            callbackGasLimit
        );
        
        vm.stopPrank();
        return orderKey;
    }

    function _mockTokenTransfers(uint256 gmxOutput, uint256 uniswapOutput) private {
        vm.mockCall(
            borrowToken,
            abi.encodeWithSignature("transfer(address,uint256)", gmxRouter, borrowAmount),
            abi.encode(true)
        );
        
        vm.mockCall(
            targetToken,
            abi.encodeWithSignature("transfer(address,uint256)", address(arbitrageur), gmxOutput),
            abi.encode(true)
        );
        
        vm.mockCall(
            targetToken,
            abi.encodeWithSignature("transfer(address,uint256)", uniswapRouter, gmxOutput),
            abi.encode(true)
        );
        
        vm.mockCall(
            borrowToken,
            abi.encodeWithSignature("transfer(address,uint256)", address(arbitrageur), uniswapOutput),
            abi.encode(true)
        );
    }

    function _getPath() private pure returns (address[] memory) {
        address[] memory path = new address[](2);
        path[0] = address(0x1);
        path[1] = address(0x2);
        return path;
    }
}