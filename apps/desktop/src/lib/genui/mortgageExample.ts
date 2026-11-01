/** Complete local calculator shared by the generation instructions and regressions. */
export const MORTGAGE_EXAMPLE = `root = Col([head, inputsCard, resultCard, detailCard, ask], 4, "stretch")
$mode = "等额本息"
$amount = 1000000
$rate = 3.5
$years = 30
head = Card([Title("房贷月供计算器", "xl"), Caption("调整参数或还款方式，结果立即更新"), SegmentedControl($mode, ["等额本息", "等额本金"], "还款方式")], "soft", 6)
inputsCard = Card([Title("参数", "md"), Grid([Slider($amount, 100000, 5000000, 50000, "贷款金额", "¥"), Slider($rate, 0, 8, 0.05, "年利率", "%"), Slider($years, 1, 40, 1, "年限", "年")], 3, 180), Caption("按月还款，月利率为年利率÷12；实际还款以银行合同为准。")], "outline", 6)
n = $years * 12
r = $rate / 1200
byPrincipal = $mode == "等额本金"
fixedPayment = @Payment($amount, $rate, n)
monthlyDecrease = byPrincipal ? $amount / n * r : 0
monthly = byPrincipal ? $amount / n + $amount * r : fixedPayment
lastPayment = byPrincipal ? $amount / n * (1 + r) : fixedPayment
interest = $rate == 0 ? 0 : byPrincipal ? $amount * r * (n + 1) / 2 : fixedPayment * n - $amount
total = $amount + interest
resultCard = Card([Title("结果（概要）", "md"), Grid([Stat(byPrincipal ? "首月还款" : "每月还款", @Format(monthly, "currency", 0), byPrincipal ? "之后逐月递减" : "每月还款额固定"), Stat("总还款", @Format(total, "currency", 0)), Stat("总利息", @Format(interest, "currency", 0), null, "warning")], 3, 180)], "soft", 6)
detailCard = Card([Title("计算要点", "md"), byPrincipal ? Row([Stat("末月还款", @Format(lastPayment, "currency", 2)), Stat("每月递减", @Format(monthlyDecrease, "currency", 2))], 6) : Text("等额本息：每月还款额固定，本金占比逐月增加，利息占比逐月减少。"), List(["月利率：" + @Format(r * 100, "percent", 4), "还款期数：" + n + " 期", byPrincipal ? "等额本金：每月本金固定，当月利息按剩余本金计算。" : "等额本息：按固定月供计算；零利率时月供为本金÷期数。"], false)], "outline", 6)
ask = Button("请 AI 分析还款压力", @ToAssistant("请结合我的收入和支出分析这笔房贷的还款压力", "还款方式：" + $mode + "；贷款金额：" + @Format($amount, "currency", 0) + "；年利率：" + @Format($rate, "percent", 2) + "；年限：" + $years + " 年；首期还款：" + @Format(monthly, "currency", 2) + "；总利息：" + @Format(interest, "currency", 2)), "solid", "sparkles")`;
