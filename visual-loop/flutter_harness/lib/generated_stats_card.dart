// 统计卡片 —— 由 LLM 依据中立蓝图手写的"生成代码"样本(契约验证用)
//
// 蓝图输入(仅使用蓝图字段):
//   卡片: PATH 102x98, svgKey S21#0, role=stack(子项绝对定位)
//   图标: PATH 15.7x16, svgKey S22#0, 相对卡片 (13.0, 2.2)
//   数值: TEXT "25" 38px JoonFont #000000, 相对 (23.4, 25.9), 实测宽 42.27
//   单位: TEXT "min" 12px #111E38, 相对 (58.4, 39.9)
//   标签: TEXT "今日学习" 12px #AAAAAA, 相对 (27.4, 58.9)
//   lineHeight=-1(字体默认) -> 不设置 height
import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

class GeneratedStatsCard extends StatelessWidget {
  const GeneratedStatsCard({
    super.key,
    required this.cardSvg,
    required this.iconSvg,
    this.value = '25',
    this.unit = 'min',
    this.label = '今日学习',
  });

  final String cardSvg;
  final String iconSvg;
  final String value;
  final String unit;
  final String label;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 102,
      height: 98,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          // 卡片背景矢量(蓝图 role=stack 首层)
          Positioned.fill(
            child: SvgPicture.string(cardSvg, fit: BoxFit.fill),
          ),
          // 图标
          Positioned(
            left: 13.0, top: 2.2,
            child: SvgPicture.string(iconSvg, width: 15.7, height: 16, fit: BoxFit.contain),
          ),
          // 数值
          Positioned(
            left: 23.4, top: 25.9,
            child: Text(value, style: const TextStyle(
              fontSize: 38, fontWeight: FontWeight.w400,
              fontFamily: 'JoonFont', color: Color(0xFF000000))),
          ),
          // 单位
          Positioned(
            left: 58.4, top: 39.9,
            child: Text(unit, style: const TextStyle(
              fontSize: 12, fontWeight: FontWeight.w400,
              fontFamily: 'HarnessCJK', color: Color(0xFF111E38))),
          ),
          // 标签
          Positioned(
            left: 27.4, top: 58.9,
            child: Text(label, style: const TextStyle(
              fontSize: 12, fontWeight: FontWeight.w400,
              fontFamily: 'HarnessCJK', color: Color(0xFFAAAAAA))),
          ),
        ],
      ),
    );
  }
}
