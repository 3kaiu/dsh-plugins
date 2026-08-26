// 胶囊按钮 —— 由 LLM 依据中立蓝图手写的"生成代码"样本(契约验证用)
//
// 蓝图输入(仅使用蓝图字段 + 资源导出表):
//   容器: 80x32, role=column, alignItems=center, padding=[6,0,6,0]
//   背景: 资源导出表 408:8777 (胶囊矢量)
//   文字: "电脑上课" 14px w500 #3E495F, 实测宽 56 (单行)
import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

class GeneratedPillButton extends StatelessWidget {
  const GeneratedPillButton({super.key, required this.backgroundSvg});

  final String backgroundSvg;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 80,
      height: 32,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          // 胶囊背景(导出表矢量)
          Positioned.fill(
            child: SvgPicture.string(backgroundSvg, fit: BoxFit.fill),
          ),
          // 蓝图: column + alignItems=center + padding [6,0,6,0]
          // 文字盒 56x20(蓝图显式尺寸) -> tight 约束锁定字形行盒(1:1 关键)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Align(
              alignment: Alignment.topCenter,
              child: SizedBox(
                width: 56,
                height: 20,
                child: Text(
                  '电脑上课',
                  softWrap: false,
                  maxLines: 1,
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w500,
                    fontFamily: 'HarnessCJK',
                    color: Color(0xFF3E495F),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
