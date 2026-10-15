//+------------------------------------------------------------------+
//| rocket1000_demo_ai.mq5                                           |
//| DEMO ONLY: GPT signal analysis, independent MT5 risk enforcement  |
//+------------------------------------------------------------------+
#property strict
#property version "1.00"
#property description "rocket1000 demo-only OpenAI bridge. Live accounts are always blocked."
#include <Trade/Trade.mqh>

input string ServerURL = "http://127.0.0.1:3000";
input string EAToken = "";                  // Never commit a real token
input string AllowedSymbol = "EURUSD";     // Must match server allowlist and chart symbol
input long AllowedDemoLogin = 0;           // Must be explicitly set to your demo login
input ENUM_TIMEFRAMES SignalTimeframe = PERIOD_M15;
input bool EnableDemoAutoTrading = false;  // Defaults OFF
input double RiskPercent = 0.25;           // Per position, percent of account equity
input double MaxDailyLossPercent = 1.0;    // Kill new orders after equity drawdown
input int MaxSpreadPoints = 20;
input int SlippagePoints = 10;
input int PollSeconds = 5;
input ulong ExpertMagic = 10002026;

CTrade trade;
datetime lastCheckedBar = 0;

string AccountKey(const string suffix)
{
   return "r1000." + IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN)) + "." + suffix;
}

bool HasEmergencyStop()
{
   string k = AccountKey("STOP");
   return GlobalVariableCheck(k) && GlobalVariableGet(k) >= 1.0;
}

bool IsSecureURL()
{
   // Plain HTTP is permitted only when the API is on the same computer.
   return StringFind(ServerURL, "https://") == 0 ||
          StringFind(ServerURL, "http://127.0.0.1:") == 0 ||
          StringFind(ServerURL, "http://localhost:") == 0;
}

bool DemoGuards()
{
   if(!EnableDemoAutoTrading || HasEmergencyStop()) return false;
   if(AccountInfoInteger(ACCOUNT_TRADE_MODE) != ACCOUNT_TRADE_MODE_DEMO) return false;
   if(AllowedDemoLogin <= 0 || AccountInfoInteger(ACCOUNT_LOGIN) != AllowedDemoLogin) return false;
   if(_Symbol != AllowedSymbol || SignalTimeframe != PERIOD_M15) return false;
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED)) return false;
   if(!AccountInfoInteger(ACCOUNT_TRADE_ALLOWED)) return false;
   if(PositionsTotal() != 0 || OrdersTotal() != 0) return false;
   if(AccountInfoDouble(ACCOUNT_EQUITY) <= 0.0) return false;
   if(!IsSecureURL() || StringLen(EAToken) < 24) return false;
   return true;
}

bool DailyLossOK()
{
   MqlDateTime t;
   datetime stamp = TimeTradeServer();
   if(stamp <= 0) return false;
   TimeToStruct(stamp, t);
   string dateKey = IntegerToString(t.year) + StringFormat("%02d%02d", t.mon, t.day);
   string k = AccountKey("EQ." + dateKey);
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   if(!GlobalVariableCheck(k)) GlobalVariableSet(k, equity);
   double startEquity = GlobalVariableGet(k);
   if(startEquity <= 0 || equity <= startEquity * (1.0 - MaxDailyLossPercent / 100.0))
      return false;
   return true;
}

double ATRFromClosedBars(MqlRates &rates[], int period = 14)
{
   if(ArraySize(rates) < period + 1) return 0.0;
   double sum = 0.0;
   for(int i = 0; i < period; i++)
   {
      double prevClose = rates[i + 1].close;
      double tr = MathMax(rates[i].high - rates[i].low,
                  MathMax(MathAbs(rates[i].high - prevClose),
                          MathAbs(rates[i].low - prevClose)));
      sum += tr;
   }
   return sum / period;
}

string CandleJSON(MqlRates &bar)
{
   return StringFormat("{\"time\":%I64d,\"open\":%s,\"high\":%s,\"low\":%s,\"close\":%s}",
      (long)bar.time,
      DoubleToString(bar.open, _Digits),
      DoubleToString(bar.high, _Digits),
      DoubleToString(bar.low, _Digits),
      DoubleToString(bar.close, _Digits));
}

string MakeSnapshot(MqlRates &rates[], int copied, double bid, double ask)
{
   string candles = "[";
   // CopyRates with AS_SERIES=true means index 0 is the last CLOSED candle.
   // Reverse the array to submit chronologically, oldest to newest.
   for(int i = copied - 1; i >= 0; i--)
   {
      if(i != copied - 1) candles += ",";
      candles += CandleJSON(rates[i]);
   }
   candles += "]";
   string body = "{";
   body += "\"accountMode\":\"DEMO\",";
   body += StringFormat("\"accountLogin\":%I64d,", (long)AccountInfoInteger(ACCOUNT_LOGIN));
   body += "\"symbol\":\"" + _Symbol + "\",";
   body += "\"timeframe\":\"M15\",";
   body += "\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",";
   body += "\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ",";
   body += "\"bid\":" + DoubleToString(bid, _Digits) + ",";
   body += "\"ask\":" + DoubleToString(ask, _Digits) + ",";
   body += "\"point\":" + DoubleToString(_Point, 9) + ",";
   body += "\"spreadPoints\":" + DoubleToString((ask - bid) / _Point, 2) + ",";
   body += "\"openPositions\":" + IntegerToString(PositionsTotal()) + ",";
   body += "\"pendingOrders\":" + IntegerToString(OrdersTotal()) + ",";
   body += StringFormat("\"marketServerTime\":%I64d,", (long)TimeTradeServer());
   body += "\"candles\":" + candles + "}";
   return body;
}

string RequestSignal(const string payload)
{
   char data[], response[];
   string headers = "Content-Type: application/json\r\nAuthorization: Bearer " + EAToken + "\r\n";
   string responseHeaders;
   int byteCount = StringToCharArray(payload, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(byteCount <= 1) return "";
   ArrayResize(data, byteCount - 1); // Remove UTF-8 null terminator
   ResetLastError();
   int status = WebRequest("POST", ServerURL + "/api/mt5/signal",
                           headers, 35000, data, response, responseHeaders);
   if(status != 200)
   {
      Print("rocket1000: signal endpoint unavailable; HTTP ", status,
            " terminal error ", GetLastError());
      return "";
   }
   return CharArrayToString(response, 0, WHOLE_ARRAY, CP_UTF8);
}

bool ExecuteRiskChecked(const ENUM_ORDER_TYPE side, MqlRates &rates[])
{
   // Repeat account, position, loss and spread checks IMMEDIATELY before placing any order.
   if(!DemoGuards() || !DailyLossOK()) return false;
   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick) || tick.ask <= tick.bid) return false;
   double spreadPoints = (tick.ask - tick.bid) / _Point;
   if(spreadPoints > MaxSpreadPoints) return false;
   double atr = ATRFromClosedBars(rates);
   if(atr <= 0.0) return false;
   long stopsLevel = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);
   double minDistance = (stopsLevel + spreadPoints + 3.0) * _Point;
   double stopDistance = MathMax(2.0 * atr, minDistance);
   double entry = side == ORDER_TYPE_BUY ? tick.ask : tick.bid;
   double sl = NormalizeDouble(side == ORDER_TYPE_BUY ? entry - stopDistance : entry + stopDistance, _Digits);
   double tp = NormalizeDouble(side == ORDER_TYPE_BUY ? entry + 2.0 * stopDistance : entry - 2.0 * stopDistance, _Digits);

   // Risk based on broker's loss estimate for 1 lot (account currency included).
   double oneLotPnl = 0.0;
   if(!OrderCalcProfit(side, _Symbol, 1.0, entry, sl, oneLotPnl) || oneLotPnl >= 0) return false;
   double cashRisk = AccountInfoDouble(ACCOUNT_EQUITY) * RiskPercent / 100.0;
   double minLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double stepLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(stepLot <= 0 || minLot <= 0 || maxLot < minLot) return false;
   double lots = MathFloor(MathMin(cashRisk / MathAbs(oneLotPnl), maxLot) / stepLot) * stepLot;
   lots = NormalizeDouble(lots, 8);
   if(lots < minLot) return false; // Never round UP to an unsafe minimum lot.
   double actualPnl = 0.0;
   if(!OrderCalcProfit(side, _Symbol, lots, entry, sl, actualPnl) ||
      actualPnl >= 0 || MathAbs(actualPnl) > cashRisk) return false;
   double margin = 0.0;
   if(!OrderCalcMargin(side, _Symbol, lots, entry, margin) ||
      margin <= 0.0 || margin > AccountInfoDouble(ACCOUNT_MARGIN_FREE) * 0.5) return false;

   trade.SetExpertMagicNumber(ExpertMagic);
   trade.SetDeviationInPoints(SlippagePoints);
   trade.SetTypeFillingBySymbol(_Symbol);
   bool sent = side == ORDER_TYPE_BUY
      ? trade.Buy(lots, _Symbol, 0.0, sl, tp, "rocket1000 DEMO AI")
      : trade.Sell(lots, _Symbol, 0.0, sl, tp, "rocket1000 DEMO AI");
   uint rc = trade.ResultRetcode();
   if(!sent || (rc != TRADE_RETCODE_DONE && rc != TRADE_RETCODE_PLACED))
   {
      Print("rocket1000: broker rejected demo order; code ", rc);
      return false;
   }
   Print("rocket1000: demo order placed, ", EnumToString(side), " lots=", lots);
   return true;
}

int OnInit()
{
   if(PollSeconds < 2 || RiskPercent <= 0.0 || RiskPercent > 0.25 ||
      MaxDailyLossPercent <= 0.0 || MaxDailyLossPercent > 1.0 ||
      MaxSpreadPoints < 1 || MaxSpreadPoints > 20)
   {
      Print("rocket1000: unsafe risk settings; EA startup rejected");
      return INIT_PARAMETERS_INCORRECT;
   }
   if(AccountInfoInteger(ACCOUNT_TRADE_MODE) != ACCOUNT_TRADE_MODE_DEMO)
   {
      Print("rocket1000: LIVE ACCOUNT BLOCKED. Attach this EA to a demo account only.");
      return INIT_FAILED;
   }
   if(!IsSecureURL())
   {
      Print("rocket1000: remote server must use HTTPS");
      return INIT_PARAMETERS_INCORRECT;
   }
   EventSetTimer(PollSeconds);
   Print("rocket1000 demo AI EA initialized; auto execution: ", EnableDemoAutoTrading);
   return INIT_SUCCEEDED;
}
void OnDeinit(const int reason) { EventKillTimer(); }

void OnTimer()
{
   if(!DemoGuards() || !DailyLossOK()) return;
   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick) || tick.ask <= tick.bid ||
      (tick.ask - tick.bid) / _Point > MaxSpreadPoints) return;

   MqlRates bars[];
   ArraySetAsSeries(bars, true);
   int copied = CopyRates(_Symbol, SignalTimeframe, 1, 40, bars);
   if(copied != 40) return;

   datetime barTime = bars[0].time;
   string dedupKey = AccountKey("BAR." + _Symbol);
   if(lastCheckedBar >= barTime) return;
   if(GlobalVariableCheck(dedupKey) && GlobalVariableGet(dedupKey) >= (double)barTime) return;
   lastCheckedBar = barTime;
   GlobalVariableSet(dedupKey, (double)barTime); // Reserve BEFORE WebRequest to avoid replays.

   string result = RequestSignal(MakeSnapshot(bars, copied, tick.bid, tick.ask));
   // The API returns compact JSON, action is the first property.
   if(StringFind(result, "{\"action\":\"BUY\"") == 0)
      ExecuteRiskChecked(ORDER_TYPE_BUY, bars);
   else if(StringFind(result, "{\"action\":\"SELL\"") == 0)
      ExecuteRiskChecked(ORDER_TYPE_SELL, bars);
   else if(result != "")
      Print("rocket1000: WAIT / blocked by risk or AI guard");
}
