// BlueprintView - 中立蓝图的确定性 Flutter 投影(参考实现, 视觉闭环 PoC 专用)
//
// mode=truth: 全部节点按 bounds 绝对定位直放 —— 作为"设计真值栅格"
//             (生产中替换为 MasterGo 导出的设计稿位图)
// mode=flex : 按 layout.role/gap/padding/对齐走真实 Flutter flex 布局 ——
//             等价于下游 LLM 按蓝图实现的语义
//
// 两模式渲染同一份内容, 差异即"flex 推断在真实 Flutter 里损失的保真度"。
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_svg/flutter_svg.dart';

Color? _parseColor(String? s) {
  if (s == null || !s.startsWith('#')) return null;
  var v = s.substring(1);
  if (v.length == 3) v = v.split('').map((c) => c + c).join();
  if (v.length == 6) v = 'FF$v';
  if (v.length != 8) return null;
  return Color(int.parse(v, radix: 16));
}

TextStyle _textStyle(Map n) {
  final fontSize = (n['fontSize'] as num?)?.toDouble() ?? 14;
  final lh = (n['lineHeight'] as num?)?.toDouble();
  return TextStyle(
    fontFamily: 'HarnessCJK',
    fontSize: fontSize,
    fontWeight: FontWeight.values[(((n['fontWeight'] as num?)?.round() ?? 400) ~/ 100).clamp(0, 8)],
    height: lh != null && fontSize > 0 ? lh / fontSize : null,
    color: _parseColor(n['color'] as String?) ?? const Color(0xFF111111),
    letterSpacing: (n['letterSpacing'] as num?)?.toDouble(),
  );
}

Widget _visual(Map n, {Map<String, String>? svgAssets, String? nodeId}) {
  final w = (n['bounds']?['width'] as num?)?.toDouble();
  final h = (n['bounds']?['height'] as num?)?.toDouble();
  Widget child;
  final realSvg = (svgAssets != null && nodeId != null) ? svgAssets[nodeId] : null;
  if (realSvg != null) {
    // 真实矢量: 导出表(id->svg)注入, 图标形状差异首次可量化
    child = SvgPicture.string(realSvg, width: w, height: h, fit: BoxFit.contain);
  } else if (n['svgKey'] != null) {
    // 矢量图标占位: 无导出表时的同形占位
    child = Container(
      decoration: BoxDecoration(border: Border.all(color: const Color(0xFF8B95A5), width: 1)),
    );
  } else if ((n['text'] as String?)?.isNotEmpty == true || n['type'] == 'TEXT') {
    child = Text(n['text'] as String? ?? '',
        style: _textStyle(n), textDirection: TextDirection.ltr, softWrap: false);
  } else {
    final ly = n['layout'] as Map? ?? {};
    final radius = ly['borderRadius'];
    Decoration? deco;
    final color = _parseColor(n['color'] as String?);
    if (color != null || radius != null) {
      deco = BoxDecoration(
        color: color,
        borderRadius: radius is List
            ? BorderRadius.only(
                topLeft: Radius.circular(((radius[0] ?? 0) as num).toDouble()),
                topRight: Radius.circular(((radius[1] ?? 0) as num).toDouble()),
                bottomRight: Radius.circular(((radius[2] ?? 0) as num).toDouble()),
                bottomLeft: Radius.circular(((radius[3] ?? 0) as num).toDouble()))
            : radius != null ? BorderRadius.circular((radius as num).toDouble()) : null,
      );
    }
    child = Container(decoration: deco);
  }
  return SizedBox(width: w, height: h, child: child);
}

MainAxisAlignment _main(String? v) => switch (v) {
      'center' => MainAxisAlignment.center,
      'end' => MainAxisAlignment.end,
      'space-between' => MainAxisAlignment.spaceBetween,
      'space-around' => MainAxisAlignment.spaceAround,
      _ => MainAxisAlignment.start,
    };

CrossAxisAlignment _cross(String? v) => switch (v) {
      'center' => CrossAxisAlignment.center,
      'end' => CrossAxisAlignment.end,
      'stretch' => CrossAxisAlignment.stretch,
      _ => CrossAxisAlignment.start,
    };

/// flex 容器递归构建: 与蓝图 emitter 相同的语义映射
Widget _flexTree(Map n, {Map<String, String>? svgAssets}) {
  final ly = n['layout'] as Map? ?? {};
  final role = ly['role'] as String? ?? 'box';
  // 导出表命中: 渲染自身矢量 + 递归子树(文字叠加), 跳过嵌套导出命中(防重影)
  if (svgAssets != null && n['id'] != null && svgAssets[n['id'] as String] != null) {
    final w = (n['bounds']?['width'] as num?)?.toDouble();
    final h = (n['bounds']?['height'] as num?)?.toDouble();
    final kids = (n['children'] as List?)?.cast<Map>() ?? const [];
    return SizedBox(
      width: w, height: h,
      child: Stack(clipBehavior: Clip.none, children: [
        Positioned.fill(
          child: SvgPicture.string(svgAssets[n['id'] as String]!, width: w, height: h, fit: BoxFit.contain),
        ),
        for (final c in kids)
          if (!(c['id'] != null && svgAssets[c['id'] as String] != null))
            Builder(builder: (_) {
              final cb = c['bounds'] as Map? ?? {};
              final left = ((cb['x'] as num? ?? 0) - (n['bounds']?['x'] as num? ?? 0)).toDouble();
              final top = ((cb['y'] as num? ?? 0) - (n['bounds']?['y'] as num? ?? 0)).toDouble();
              return Positioned(left: left, top: top, child: _flexTree(c, svgAssets: svgAssets));
            }),
      ]),
    );
  }
  final kids = (n['children'] as List?)?.cast<Map>() ?? const [];
  Widget node;

  if (kids.isEmpty) {
    node = _visual(n, svgAssets: svgAssets, nodeId: n['id'] as String?);
  } else if (role == 'stack') {
    final pb = n['bounds'] as Map? ?? {};
    node = SizedBox(
      width: (pb['width'] as num?)?.toDouble(),
      height: (pb['height'] as num?)?.toDouble(),
      child: Stack(clipBehavior: Clip.none, children: [
        for (final c in kids)
          Builder(builder: (_) {
            final cb = c['bounds'] as Map? ?? {};
            final left = ((cb['x'] as num? ?? 0) - (pb['x'] as num? ?? 0)).toDouble();
            final top = ((cb['y'] as num? ?? 0) - (pb['y'] as num? ?? 0)).toDouble();
            return Positioned(left: left, top: top, width: (cb['width'] as num?)?.toDouble(), height: (cb['height'] as num?)?.toDouble(), child: _flexTree(c, svgAssets: svgAssets));
          })
      ]),
    );
  } else if (role == 'row' || role == 'column') {
    final gapArr = ly['gap'] is List;
    final children = <Widget>[];
    for (var i = 0; i < kids.length; i++) {
      final c = kids[i];
      var child = _flexTree(c, svgAssets: svgAssets);
      // 真值驱动的交叉轴残差校正: 布局后平移(start 容器下等价 margin 语义)
      final crossOff = (c['layout']?['crossOffset'] as num?)?.toDouble() ?? 0;
      if (crossOff != 0) {
        child = Transform.translate(offset: Offset(role == 'column' ? crossOff : 0, role == 'row' ? crossOff : 0), child: child);
      }
      if (gapArr && i > 0) {
        final gap = ((ly['gap'] as List)[i - 1] as num? ?? 0).toDouble();
        if (gap > 0) {
          child = Padding(padding: EdgeInsets.only(top: role == 'column' ? gap : 0, left: role == 'row' ? gap : 0), child: child);
        } else if (gap < 0) {
          child = Transform.translate(offset: Offset(role == 'row' ? gap : 0, role == 'column' ? gap : 0), child: child);
        }
      }
      children.add(child);
    }
    final uniformGap = (!gapArr && ((ly['gap'] as num?) ?? 0) > 0) ? (ly['gap'] as num).toDouble() : 0.0;
    Widget flex = role == 'row'
        ? Row(mainAxisSize: MainAxisSize.min, crossAxisAlignment: _cross(ly['alignItems'] as String?), mainAxisAlignment: _main(ly['justifyContent'] as String?), spacing: uniformGap, textDirection: TextDirection.ltr, children: children)
        : Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: _cross(ly['alignItems'] as String?), mainAxisAlignment: _main(ly['justifyContent'] as String?), spacing: uniformGap, textDirection: TextDirection.ltr, children: children);
    // 设计尺寸约束: 锁定容器包围盒(1:1 关键)。
    // 内容主轴超设计尺寸时(文本换行/度量差异)以设计盒裁切 —— 不可滚动 Scroll 让
    // 子项按自然尺寸布局且不触发 overflow 异常, ClipRect 保证像素不越界。
    final cw = (n['bounds']?['width'] as num?)?.toDouble();
    final ch = (n['bounds']?['height'] as num?)?.toDouble();
    // 容器 padding(flex 分支同样承载间距语义): [top,right,bottom,left]
    final fpad = (ly['padding'] as List?)?.map((e) => (e as num).toDouble()).toList() ?? const [0, 0, 0, 0];
    if (fpad.any((v) => v != 0)) {
      flex = Padding(padding: EdgeInsets.fromLTRB(fpad[3], fpad[0], fpad[1], fpad[2]), child: flex);
    }
    if (cw != null || ch != null) {
      final mainVertical = role == 'column';
      flex = SizedBox(
        width: cw, height: ch,
        child: ClipRect(
          child: SingleChildScrollView(
            physics: const NeverScrollableScrollPhysics(),
            scrollDirection: mainVertical ? Axis.vertical : Axis.horizontal,
            child: flex,
          ),
        ),
      );
    }
    // 容器自身背景/圆角(flex 分支同样承载视觉语义)
    final bg = _parseColor(n['color'] as String?);
    final flexRadius = ly['borderRadius'];
    if (bg != null || flexRadius != null) {
      flex = Container(
        decoration: BoxDecoration(
          color: bg,
          borderRadius: flexRadius is List
              ? BorderRadius.only(
                  topLeft: Radius.circular(((flexRadius[0] ?? 0) as num).toDouble()),
                  topRight: Radius.circular(((flexRadius[1] ?? 0) as num).toDouble()),
                  bottomRight: Radius.circular(((flexRadius[2] ?? 0) as num).toDouble()),
                  bottomLeft: Radius.circular(((flexRadius[3] ?? 0) as num).toDouble()))
              : flexRadius != null ? BorderRadius.circular((flexRadius as num).toDouble()) : null,
        ),
        child: flex,
      );
    }
    node = flex;
  } else {
    // box: 有设计尺寸时用 SizedBox 约束(保证 Stack 有界); 无尺寸退化为单视觉节点
    final w = (n['bounds']?['width'] as num?)?.toDouble();
    final h = (n['bounds']?['height'] as num?)?.toDouble();
    if (w == null || h == null) return _visual(n);
    final pad = (ly['padding'] as List?)?.map((e) => (e as num).toDouble()).toList() ?? [0, 0, 0, 0];
    node = Padding(
      padding: EdgeInsets.fromLTRB(pad[3], pad[0], pad[1], pad[2]),
      child: SizedBox(
        width: w, height: h,
        child: Stack(clipBehavior: Clip.none, children: [Positioned(left: 0, top: 0, child: _visual({'bounds': {'width': w, 'height': h}, 'type': n['type'], 'color': n['color'], 'layout': ly})), for (final c in kids) Positioned(left: 0, top: 0, child: _flexTree(c, svgAssets: svgAssets))]),
      ),
    );
  }
  return node;
}

class BlueprintView extends StatelessWidget {
  const BlueprintView({super.key, required this.spec});
  final Map<String, dynamic> spec;

  @override
  Widget build(BuildContext context) {
    final width = (spec['width'] as num).toDouble();
    final height = (spec['height'] as num).toDouble();
    if (spec['mode'] == 'truth') {
      return SizedBox(
        width: width, height: height,
        child: Stack(clipBehavior: Clip.none, children: [
          for (final item in (spec['items'] as List).cast<Map>())
            Positioned(
              left: (item['bounds']['x'] as num).toDouble(),
              top: (item['bounds']['y'] as num).toDouble(),
              child: _visual(item, svgAssets: (spec['svgAssets'] as Map?)?.cast<String, String>(), nodeId: item['id'] as String?),
            )
        ]),
      );
    }
    // flex 模式: roots 按自身 bounds 绝对放置(页面壳原点为画布 0,0, 内部再走 flow);
    // floatings 悬浮层同语义 —— 忠实蓝图的 Z 轴分层。
    // Stack 只含 Positioned 子项时无内在尺寸, 按内容最深底边显式定高。
    double contentBottom = 0;
    for (final list in [(spec['tree'] ?? []) as List, (spec['floatings'] ?? []) as List]) {
      for (final n in list.cast<Map>()) {
        final b = n['bounds'] as Map? ?? {};
        final bb = (((b['y'] as num?) ?? 0) + ((b['height'] as num?) ?? 0)).toDouble();
        if (bb > contentBottom) contentBottom = bb;
      }
    }
    return SizedBox(
      width: width,
      height: contentBottom > 0 ? contentBottom : null,
      child: Stack(clipBehavior: Clip.none, children: [
        for (final root in (spec['tree'] as List).cast<Map>())
          Positioned(
            left: ((root['bounds']?['x'] as num?) ?? 0).toDouble(),
            top: ((root['bounds']?['y'] as num?) ?? 0).toDouble(),
            child: _flexTree(root, svgAssets: (spec['svgAssets'] as Map?)?.cast<String, String>()),
          ),
        for (final f in (spec['floatings'] as List?)?.cast<Map>() ?? const [])
          Positioned(
            left: ((f['bounds']?['x'] as num?) ?? 0).toDouble(),
            top: ((f['bounds']?['y'] as num?) ?? 0).toDouble(),
            child: _flexTree(f, svgAssets: (spec['svgAssets'] as Map?)?.cast<String, String>()),
          ),
      ]),
    );
  }
}

/// 渲染树文本块收集: 输出与设计侧同构的 {text,x,y,width,height} 清单(D2C 块级指标用)
String collectTextBlocks(RenderObject root, {double dx = 0, double dy = 0}) {
  final blocks = <Map<String, dynamic>>[];
  void visit(RenderObject ro) {
    if (ro is RenderParagraph) {
      final pos = ro.localToGlobal(Offset.zero);
      blocks.add({
        'text': ro.text.toPlainText(),
        'x': pos.dx, 'y': pos.dy,
        'width': ro.size.width, 'height': ro.size.height,
      });
    }
    ro.visitChildren(visit);
  }
  visit(root);
  return jsonEncode(blocks);
}
