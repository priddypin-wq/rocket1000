// ROCKET1000 EA: real MT5 broker execution with account-bound server authorization.
#property copyright "ROCKET1000"
#property version   "6.00"
#property description "ROCKET1000 EA - real Demo/Live market data and account-authorized broker execution."
#property strict

string backend_url="", credential="", installation_id="";
string current_status="Connecting";
bool registered=false;
int retry_seconds=5;
ulong next_attempt=0;
string terminal_session="",pending_result="";
string terminal_id="",account_stamp="",ea_instance="";
string positions_snapshot="[]",broker_pending_snapshot="[]";
bool positions_available=false,broker_pending_available=false;
double clock_anchor=0,realized_today=0;
ulong clock_tick=0;
datetime broker_anchor=0;
ulong broker_clock=0,market_notice=0;
ulong timeframe_notice[4];
string performance_cache="",performance_account="";
ulong performance_until=0;
ulong performance_notice=0;
bool order_permission=false;
double risk_day_start=0,risk_daily_loss=0,risk_peak=0,risk_existing=0;
bool risk_stops=false,news_verified=false,news_blocked=true,daily_history_verified=false;
double commission_per_lot=0;
bool costs_verified=false,loss_history_verified=false;
int consecutive_losses=0;
string risk_account="",cost_account="";
ulong costs_until=0;
string quote_symbols[100];long quote_millis[100];ulong quote_observed[100];int quote_count=0;
string active_id="",active_lease="",active_kind="",active_symbol="",active_identifier="";
ulong active_order=0,active_position=0;
double active_volume=0,active_filled=0,active_value=0,active_stop=0,active_tp=0;
ulong active_deals[128];int active_deal_count=0;

string Trim(string value) { StringTrimLeft(value); StringTrimRight(value); return value; }
bool SafeCredential(string value) {
   if(StringLen(value)<70 || StringLen(value)>160 || StringFind(value,"r1000.")!=0) return false;
   for(int i=0;i<StringLen(value);i++) {
      ushort c=StringGetCharacter(value,i);
      if(!((c>='a' && c<='z') || (c>='A' && c<='Z') || (c>='0' && c<='9') || c=='-' || c=='_' || c=='.')) return false;
   }
   return true;
}
bool SafeOrigin(string value) {
   if(StringFind(value,"https://")!=0 || StringLen(value)<12) return false;
   string host=StringSubstr(value,8);
   if(StringFind(host,".")<1 || StringFind(host,"localhost")>=0) return false;
   for(int i=0;i<StringLen(host);i++) {
      ushort c=StringGetCharacter(host,i);
      if(!((c>='a' && c<='z') || (c>='A' && c<='Z') || (c>='0' && c<='9') || c=='-' || c=='.')) return false;
   }
   return true;
}
void ShowStatus(string value) {
   if(value!=current_status) Print("ROCKET1000 EA: ",value);
   current_status=value;
   string account_label=AccountInfoInteger(ACCOUNT_TRADE_MODE)==ACCOUNT_TRADE_MODE_DEMO?"Demo":(AccountInfoInteger(ACCOUNT_TRADE_MODE)==ACCOUNT_TRADE_MODE_REAL?"Live":"Unknown");
   Comment("ROCKET1000 EA 6.00\n",value,"\nAccount type: ",account_label,"\nBroker execution: ",(order_permission?"PERMISSION ACTIVE":"STOPPED"),"\n",backend_url);
}
// ROCKET1000_CONFIG_BEGIN
bool ConfigFailure(string reason,int error=0){
   static ulong next_notice=0;
   if(GetTickCount64()>=next_notice){
      Print("ROCKET1000 EA: configuration unavailable - ",reason,". Expected MQL5/Files/ROCKET1000/rocket1000.config. MT5 file error=",error,". Extract the personalized package into this terminal's data folder. Trading remains stopped.");
      next_notice=GetTickCount64()+30000;
   }
   return false;
}
bool ConfigIdValid(string value){
   if(StringLen(value)!=36)return false;
   for(int i=0;i<36;i++){
      ushort ch=StringGetCharacter(value,i);
      if(i==8 || i==13 || i==18 || i==23){if(ch!='-')return false;}
      else if(!((ch>='0' && ch<='9') || (ch>='a' && ch<='f')))return false;
   }
   return true;
}
bool LoadConfig() {
   ResetLastError();
   int file=FileOpen("ROCKET1000\\rocket1000.config",FILE_READ|FILE_TXT|FILE_ANSI|FILE_SHARE_READ,0,CP_UTF8);
   if(file==INVALID_HANDLE)return ConfigFailure("file is missing or cannot be read",GetLastError());
   if(FileSize(file)>4096){FileClose(file);return ConfigFailure("file exceeds the configuration size limit");}
   string url="",token="",id="",version="",expires="";
   bool duplicate=false;
   int lines=0;
   while(!FileIsEnding(file) && lines++<20) {
      string line=Trim(FileReadString(file));
      // CP_UTF8 decodes an optional BOM as U+FEFF; never let it hide the first key.
      if(StringLen(line)>0 && StringGetCharacter(line,0)==0xFEFF)line=Trim(StringSubstr(line,1));
      StringReplace(line,"\r","");StringReplace(line,"\n","");
      int equals=StringFind(line,"="); if(equals<0) continue;
      string key=Trim(StringSubstr(line,0,equals)),value=Trim(StringSubstr(line,equals+1));
      if(key=="backend_url"){if(url!="")duplicate=true;url=value;}
      if(key=="credential"){if(token!="")duplicate=true;token=value;}
      if(key=="installation_id"){if(id!="")duplicate=true;id=value;}
      if(key=="version"){if(version!="")duplicate=true;version=value;}
      if(key=="expires_at"){if(expires!="")duplicate=true;expires=value;}
   }
   bool too_long=!FileIsEnding(file);
   FileClose(file);
   if(too_long || duplicate || version!="1" || !SafeOrigin(url) || !SafeCredential(token) || !ConfigIdValid(id) || StringFind(token,"r1000."+id+".")!=0 || StringLen(token)!=86)return ConfigFailure("format or installation identity is invalid");
   for(int i=43;i<86;i++){
      ushort ch=StringGetCharacter(token,i);
      if(!((ch>='a' && ch<='z') || (ch>='A' && ch<='Z') || (ch>='0' && ch<='9') || ch=='-' || ch=='_'))return ConfigFailure("credential format is invalid");
   }
   if(StringLen(expires)!=10)return ConfigFailure("expiration timestamp is missing or invalid");
   for(int i=0;i<10;i++){ushort ch=StringGetCharacter(expires,i);if(ch<'0' || ch>'9')return ConfigFailure("expiration timestamp is invalid");}
   long expiry=StringToInteger(expires);datetime utc=clock_anchor>0?(datetime)(ServerNow()/1000):TimeGMT();
   if(expiry<1577836800 || expiry>4102444800 || utc<=0 || expiry<=(long)utc)return ConfigFailure("credential expired; download the current authorized installation");
   if(token!=credential || url!=backend_url) registered=false;
   backend_url=url;credential=token;installation_id=id;
   return true;
}
// ROCKET1000_CONFIG_END
string EscapeJson(string value) {
   StringReplace(value,"\\","\\\\");StringReplace(value,"\"","\\\"");
   StringReplace(value,"\r","\\r");StringReplace(value,"\n","\\n");StringReplace(value,"\t","\\t");
   return value;
}
datetime BrokerNow() {
   // Quote timestamps and session/calendar timestamps are broker time, never GMT.
   datetime estimated=TimeTradeServer();ulong tick=GetTickCount64();
   if(estimated>0 && TerminalInfoInteger(TERMINAL_CONNECTED)){broker_anchor=estimated;broker_clock=tick;return estimated;}
   if(broker_anchor<=0 || tick-broker_clock>90000)return 0;
   return broker_anchor+(datetime)((tick-broker_clock)/1000);
}
bool FreshQuote(string symbol,MqlTick &quote,int max_age){
   if(!SymbolInfoTick(symbol,quote) || quote.bid<=0 || quote.ask<quote.bid || quote.time_msc<=0)return false;
   datetime server=BrokerNow();if(server<=0)return false;
   long age=(long)server*1000-quote.time_msc;
   if(age < -2000 || age>(long)max_age*1000)return false;
   int index=-1;
   for(int i=0;i<quote_count;i++)if(quote_symbols[i]==symbol){index=i;break;}
   if(index<0){if(quote_count>=100)return false;index=quote_count++;quote_symbols[index]=symbol;quote_millis[index]=0;quote_observed[index]=0;}
   ulong monotonic=GetTickCount64();
   if(quote_millis[index]!=quote.time_msc){
      // An unchanged quote may not be made fresh by HTTP retries or clock changes.
      if(quote_millis[index]>quote.time_msc)return false;
      quote_millis[index]=quote.time_msc;
      quote_observed[index]=monotonic-(ulong)MathMin(MathMax(0,age),(long)monotonic);
   }
   return monotonic-quote_observed[index]<=(ulong)max_age*1000;
}
string MarketUnavailable(string reason){
   if(GetTickCount64()>=market_notice){Print("ROCKET1000 EA: waiting for market data - ",reason);market_notice=GetTickCount64()+60000;}
   return "";
}
string TimeframeUnavailable(string label,int notice_index,string reason){
   if(GetTickCount64()>=timeframe_notice[notice_index]){
      Print("ROCKET1000 EA: ",label," history unavailable - ",reason,". Multi-timeframe AI analysis will wait for real broker candles.");
      timeframe_notice[notice_index]=GetTickCount64()+60000;
   }
   return "";
}
string ClosedBars(ENUM_TIMEFRAMES period,string label,int notice_index,int minimum,datetime broker_now,int &count){
   MqlRates bars[];ArraySetAsSeries(bars,false);ResetLastError();
   // Position 1 excludes the current, unfinished candle. Never synthesize another timeframe.
   count=CopyRates(_Symbol,period,1,220,bars);
   int seconds=PeriodSeconds(period);
   if(count<minimum || count>220 || seconds<=0)return TimeframeUnavailable(label,notice_index,"CopyRates count="+IntegerToString(count)+", error="+IntegerToString(GetLastError()));
   if(bars[count-1].time+seconds>broker_now+2 || broker_now-(bars[count-1].time+seconds)>2*seconds)return TimeframeUnavailable(label,notice_index,"latest closed candle is stale or incomplete");
   string candles="[";
   for(int i=0;i<count;i++){
      if(bars[i].time<=0 || (i>0 && bars[i].time<=bars[i-1].time) || !MathIsValidNumber(bars[i].open) || !MathIsValidNumber(bars[i].high) || !MathIsValidNumber(bars[i].low) || !MathIsValidNumber(bars[i].close) || bars[i].low<=0 || bars[i].high<bars[i].low || bars[i].open<bars[i].low || bars[i].open>bars[i].high || bars[i].close<bars[i].low || bars[i].close>bars[i].high || bars[i].tick_volume<0)return TimeframeUnavailable(label,notice_index,"invalid broker candle");
      if(i>0)candles+=",";
      candles+="{\"time\":"+IntegerToString(bars[i].time)+",\"open\":"+DoubleToString(bars[i].open,8)+",\"high\":"+DoubleToString(bars[i].high,8)+",\"low\":"+DoubleToString(bars[i].low,8)+",\"close\":"+DoubleToString(bars[i].close,8)+",\"volume\":"+IntegerToString(bars[i].tick_volume)+"}";
   }
   return candles+"]";
}
string MarketSnapshot() {
   if(clock_anchor<=0)return "";
   MqlTick quote;
   datetime broker_now=BrokerNow();
   if(!FreshQuote(_Symbol,quote,15)) return MarketUnavailable("stale chart quote; broker time="+IntegerToString(broker_now)+", quote time="+IntegerToString(quote.time));
   int count=0;
   string candles=ClosedBars(PERIOD_M5,"M5",1,50,broker_now,count);
   if(candles=="")return "";
   // Root M5 preserves the connection bridge; completed 220-bar frames support EMA200.
   string timeframes="{";int frames=0;
   if(count==220){timeframes+="\"M5\":{\"bars\":"+candles+"}";frames++;}
   else TimeframeUnavailable("M5",1,"220 closed candles required; count="+IntegerToString(count));
   string m1=ClosedBars(PERIOD_M1,"M1",0,220,broker_now,count);
   if(m1!=""){if(frames++>0)timeframes+=",";timeframes+="\"M1\":{\"bars\":"+m1+"}";}
   string m15=ClosedBars(PERIOD_M15,"M15",2,220,broker_now,count);
   if(m15!=""){if(frames++>0)timeframes+=",";timeframes+="\"M15\":{\"bars\":"+m15+"}";}
   string h1=ClosedBars(PERIOD_H1,"H1",3,220,broker_now,count);
   if(h1!=""){if(frames++>0)timeframes+=",";timeframes+="\"H1\":{\"bars\":"+h1+"}";}
   timeframes+="}";
   if(!positions_available)return MarketUnavailable("broker position enumeration is incomplete");
   string clocks="\"brokerTimestamp\":"+IntegerToString((long)broker_now*1000)+",\"quoteTimestamp\":"+IntegerToString(quote.time_msc)+",";
   string snapshot="{"+clocks+"\"symbol\":\""+EscapeJson(_Symbol)+"\",\"timeframe\":\"M5\",\"timestamp\":"+IntegerToString((long)ServerNow())+",\"bid\":"+DoubleToString(quote.bid,8)+",\"ask\":"+DoubleToString(quote.ask,8)+",\"balance\":"+DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE),2)+",\"equity\":"+DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY),2)+",\"currency\":\""+EscapeJson(AccountInfoString(ACCOUNT_CURRENCY))+"\",\"bars\":"+candles+",\"timeframes\":"+timeframes+",\"positions\":"+positions_snapshot+"}";
   char encoded[];
   if(StringToCharArray(snapshot,encoded,0,WHOLE_ARRAY,CP_UTF8)-1>360000)return MarketUnavailable("market payload exceeds the bounded connection budget");
   return snapshot;
}
double ServerNow(){return clock_anchor+(double)(GetTickCount64()-clock_tick);}
string AccountStamp(){return IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))+"|"+AccountInfoString(ACCOUNT_SERVER)+"|"+IntegerToString(AccountInfoInteger(ACCOUNT_TRADE_MODE));}
bool PositionHistoryIntegrity(ulong identifier,string &origin_comment){
   origin_comment="";
   if(identifier==0 || !HistorySelectByPosition(identifier) || HistoryDealsTotal()>10000)return false;
   bool found=false;long first_time=0;
   for(int n=0;n<HistoryDealsTotal();n++){
      ulong deal=HistoryDealGetTicket(n);if(deal==0)return false;
      long type=HistoryDealGetInteger(deal,DEAL_TYPE),entry=HistoryDealGetInteger(deal,DEAL_ENTRY);
      if(type!=DEAL_TYPE_BUY && type!=DEAL_TYPE_SELL)continue;
      // A mixed manual/other-EA or netting reversal position is never ours to manage.
      if(HistoryDealGetInteger(deal,DEAL_MAGIC)!=100061 || entry==DEAL_ENTRY_INOUT)return false;
      if(entry==DEAL_ENTRY_IN){
         string comment=HistoryDealGetString(deal,DEAL_COMMENT);
         ulong order=(ulong)HistoryDealGetInteger(deal,DEAL_ORDER);
         if(StringFind(comment,"R1000:")!=0)comment=HistoryOrderGetString(order,ORDER_COMMENT);
         if(StringFind(comment,"R1000:")!=0 || StringLen(comment)!=30)return false;
         long when=HistoryDealGetInteger(deal,DEAL_TIME_MSC);
         if(!found || when<first_time){origin_comment=comment;first_time=when;}
         found=true;
      }
   }
   return found;
}
bool PositionIntegrity(){
   if(PositionGetInteger(POSITION_MAGIC)!=100061 || StringFind(PositionGetString(POSITION_COMMENT),"R1000:")!=0)return false;
   string origin;return PositionHistoryIntegrity((ulong)PositionGetInteger(POSITION_IDENTIFIER),origin);
}
bool WinningAdditionsAllowed(string symbol,string side,MqlTick &quote){
   int total=PositionsTotal();if(total>100)return false;
   for(int i=0;i<total;i++){
      if(PositionGetTicket(i)==0)return false;
      if(PositionGetString(POSITION_SYMBOL)!=symbol)continue;
      // Netting would merge positions and ownership. Never average down or add to an unknown trade.
      if(AccountInfoInteger(ACCOUNT_MARGIN_MODE)!=ACCOUNT_MARGIN_MODE_RETAIL_HEDGING || !PositionIntegrity())return false;
      bool buy=PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY;
      if((buy?"BUY":"SELL")!=side)return false;
      double entry=PositionGetDouble(POSITION_PRICE_OPEN),stop=PositionGetDouble(POSITION_SL),profit=PositionGetDouble(POSITION_PROFIT);
      if(!MathIsValidNumber(entry) || !MathIsValidNumber(stop) || !MathIsValidNumber(profit) || entry<=0 || stop<=0 || profit<=0)return false;
      if(buy?(quote.bid<=entry || stop<entry):(quote.ask>=entry || stop>entry))return false;
   }
   return PositionsTotal()==total;
}
string TerminalIdentity(){
   if(!GlobalVariableCheck("R1000.terminal.1") || !GlobalVariableCheck("R1000.terminal.2") || !GlobalVariableCheck("R1000.terminal.3")){
      if(GlobalVariableSet("R1000.terminal.1",(double)(uint)TimeLocal())==0 || GlobalVariableSet("R1000.terminal.2",(double)(uint)GetMicrosecondCount())==0 || GlobalVariableSet("R1000.terminal.3",(double)(uint)GetTickCount64())==0)return "";
      GlobalVariablesFlush();
   }
   return StringFormat("%08x%08x%08x",(uint)GlobalVariableGet("R1000.terminal.1"),(uint)GlobalVariableGet("R1000.terminal.2"),(uint)GlobalVariableGet("R1000.terminal.3"));
}
string NewSession() {
   return StringFormat("%08x%08x%08x",(uint)TimeLocal(),(uint)GetMicrosecondCount(),(uint)GetTickCount64());
}
uint NameHash(string value) {
   uint h=2166136261;
   for(int i=0;i<StringLen(value);i++)h=(h^(uint)StringGetCharacter(value,i))*16777619;
   return h;
}
bool IsCalendarCurrency(string value) {
   return StringFind("|USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|CNY|", "|"+value+"|")>=0;
}
bool CheckCurrencyNews(string currency) {
   MqlCalendarValue values[];datetime now=BrokerNow();ResetLastError();
   int count=CalendarValueHistory(values,now-1800,now+1800,NULL,currency);
   if(count<0 || GetLastError()!=0)return false;
   for(int i=0;i<count;i++) {
      MqlCalendarEvent event;
      if(!CalendarEventById(values[i].event_id,event))return false;
      if(event.importance==CALENDAR_IMPORTANCE_HIGH)news_blocked=true;
   }
   return true;
}
bool IsOpenIdentifier(ulong identifier){
   int total=PositionsTotal();if(total>100)return true;
   for(int i=0;i<total;i++){if(PositionGetTicket(i)==0)return true;if((ulong)PositionGetInteger(POSITION_IDENTIFIER)==identifier)return true;}
   return PositionsTotal()!=total;
}
void RefreshObservedHistory(){
   string account=AccountStamp()+"|"+_Symbol;ulong monotonic=GetTickCount64();
   if(cost_account==account && monotonic<costs_until)return;
   cost_account=account;costs_until=monotonic+60000;commission_per_lot=0;costs_verified=false;loss_history_verified=false;consecutive_losses=0;
   // Use actual complete account history, including manual trades, for the account loss streak.
   // Empty history verifies a zero streak, but cannot verify a symbol's commission schedule.
   if(!HistorySelect(0,BrokerNow()))return;
   int total=HistoryDealsTotal();if(total>10000)return;
   ulong identifiers[];if(ArrayResize(identifiers,total)!=total)return;
   for(int i=0;i<total;i++){
      ulong deal=HistoryDealGetTicket(i);if(deal==0)return;
      identifiers[i]=(ulong)HistoryDealGetInteger(deal,DEAL_POSITION_ID);
   }
   if(total>0 && !ArraySort(identifiers))return;
   double incoming[],outgoing[],net[],fees[];long closed_at[];bool focus[],reversal[],entered[];
   if(ArrayResize(incoming,total)!=total || ArrayResize(outgoing,total)!=total || ArrayResize(net,total)!=total || ArrayResize(fees,total)!=total || ArrayResize(closed_at,total)!=total || ArrayResize(focus,total)!=total || ArrayResize(reversal,total)!=total || ArrayResize(entered,total)!=total)return;
   ArrayInitialize(incoming,0);ArrayInitialize(outgoing,0);ArrayInitialize(net,0);ArrayInitialize(fees,0);ArrayInitialize(closed_at,0);ArrayInitialize(focus,false);ArrayInitialize(reversal,false);ArrayInitialize(entered,false);
   bool unallocated_fee=false;
   for(int i=0;i<total;i++){
      ulong deal=HistoryDealGetTicket(i);if(deal==0)return;
      long type=HistoryDealGetInteger(deal,DEAL_TYPE),entry=HistoryDealGetInteger(deal,DEAL_ENTRY);
      double profit=0,commission=0,swap=0,fee=0,volume=0;
      if(!HistoryDealGetDouble(deal,DEAL_PROFIT,profit) || !HistoryDealGetDouble(deal,DEAL_COMMISSION,commission) || !HistoryDealGetDouble(deal,DEAL_SWAP,swap) || !HistoryDealGetDouble(deal,DEAL_FEE,fee) || !HistoryDealGetDouble(deal,DEAL_VOLUME,volume) || !MathIsValidNumber(profit) || !MathIsValidNumber(commission) || !MathIsValidNumber(swap) || !MathIsValidNumber(fee) || !MathIsValidNumber(volume))return;
      ulong identifier=(ulong)HistoryDealGetInteger(deal,DEAL_POSITION_ID);
      if(identifier==0){
         if(commission<0 || fee<0 || (type!=DEAL_TYPE_BALANCE && type!=DEAL_TYPE_CREDIT && type!=DEAL_TYPE_BONUS && type!=DEAL_TYPE_CORRECTION && profit<0))unallocated_fee=true;
         continue;
      }
      int group=ArrayBsearch(identifiers,identifier);if(group<0 || identifiers[group]!=identifier)return;
      net[group]+=profit+commission+swap+fee;
      fees[group]+=MathMax(0,-commission)+MathMax(0,-fee);
      if(type!=DEAL_TYPE_BUY && type!=DEAL_TYPE_SELL){if(profit<0)fees[group]+=-profit;continue;}
      if(volume<=0)return;
      if(HistoryDealGetString(deal,DEAL_SYMBOL)==_Symbol)focus[group]=true;
      if(entry==DEAL_ENTRY_IN){incoming[group]+=volume;entered[group]=true;}
      else if(entry==DEAL_ENTRY_INOUT){reversal[group]=true;closed_at[group]=MathMax(closed_at[group],HistoryDealGetInteger(deal,DEAL_TIME_MSC));}
      else if(entry==DEAL_ENTRY_OUT || entry==DEAL_ENTRY_OUT_BY){outgoing[group]+=volume;closed_at[group]=MathMax(closed_at[group],HistoryDealGetInteger(deal,DEAL_TIME_MSC));}
      else return;
   }
   long latest[3];double outcomes[3];ulong latest_id[3];ArrayInitialize(latest,0);ArrayInitialize(outcomes,0);ArrayInitialize(latest_id,0);
   for(int i=0;i<total;i++){
      if(closed_at[i]<=0 || IsOpenIdentifier(identifiers[i]))continue;
      if(!entered[i])return; // A truncated broker lineage is not a verified closed trade.
      if(focus[i] && !reversal[i] && incoming[i]>0 && MathAbs(incoming[i]-outgoing[i])<=0.00000001){
         double observed=fees[i]/incoming[i];if(!MathIsValidNumber(observed) || observed<0)return;
         commission_per_lot=MathMax(commission_per_lot,observed);costs_verified=true;
      }
      if(MathAbs(net[i])<0.00000001)continue; // Breakeven does not erase prior losses.
      for(int n=0;n<3;n++)if(closed_at[i]>latest[n] || (closed_at[i]==latest[n] && identifiers[i]>latest_id[n])){
         for(int k=2;k>n;k--){latest[k]=latest[k-1];outcomes[k]=outcomes[k-1];latest_id[k]=latest_id[k-1];}
         latest[n]=closed_at[i];outcomes[n]=net[i];latest_id[n]=identifiers[i];break;
      }
   }
   for(int i=0;i<3;i++){if(latest[i]<=0 || outcomes[i]>=0)break;consecutive_losses++;}
   loss_history_verified=true;if(unallocated_fee)costs_verified=false;
   string prefix="R1000.losses."+IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))+"."+IntegerToString(NameHash(AccountInfoString(ACCOUNT_SERVER)));
   if(GlobalVariableSet(prefix,(double)consecutive_losses)==0){loss_history_verified=false;costs_verified=false;return;}
   GlobalVariablesFlush();
}
void RefreshRisk() {
   RefreshObservedHistory();
   news_blocked=false;news_verified=true;int currencies=0;
   string base=SymbolInfoString(_Symbol,SYMBOL_CURRENCY_BASE),profit=SymbolInfoString(_Symbol,SYMBOL_CURRENCY_PROFIT);
   if(IsCalendarCurrency(base)){currencies++;if(!CheckCurrencyNews(base))news_verified=false;}
   if(IsCalendarCurrency(profit) && profit!=base){currencies++;if(!CheckCurrencyNews(profit))news_verified=false;}
   if(currencies==0)news_verified=false;
   MqlDateTime day;TimeToStruct(BrokerNow(),day);day.hour=0;day.min=0;day.sec=0;
   double net=0;bool history_ok=HistorySelect(StructToTime(day),BrokerNow());
   if(history_ok)for(int i=0;i<HistoryDealsTotal();i++) {
      ulong ticket=HistoryDealGetTicket(i);if(ticket==0){history_ok=false;break;}
      long type=HistoryDealGetInteger(ticket,DEAL_TYPE);
      if(type!=DEAL_TYPE_BALANCE && type!=DEAL_TYPE_CREDIT && type!=DEAL_TYPE_BONUS && type!=DEAL_TYPE_CORRECTION)net+=HistoryDealGetDouble(ticket,DEAL_PROFIT)+HistoryDealGetDouble(ticket,DEAL_COMMISSION)+HistoryDealGetDouble(ticket,DEAL_SWAP)+HistoryDealGetDouble(ticket,DEAL_FEE);
   }
   double balance=AccountInfoDouble(ACCOUNT_BALANCE),equity=AccountInfoDouble(ACCOUNT_EQUITY);
   daily_history_verified=history_ok;
   string day_name="R1000.day."+IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))+"."+IntegerToString(NameHash(AccountInfoString(ACCOUNT_SERVER)))+"."+IntegerToString(StructToTime(day));
   if(!GlobalVariableCheck(day_name) && history_ok && balance-net>0)GlobalVariableSet(day_name,balance-net);
   realized_today=net;risk_day_start=GlobalVariableCheck(day_name)?GlobalVariableGet(day_name):0;
   // Persist the broker-day baseline; include current floating losses and never offset them with earlier wins.
   risk_daily_loss=MathMax(MathMax(0,risk_day_start-equity),MathMax(0,-net)+MathMax(0,balance-equity));
   string peak_name="R1000.peak."+IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))+"."+IntegerToString(NameHash(AccountInfoString(ACCOUNT_SERVER)));
   risk_peak=GlobalVariableCheck(peak_name)?GlobalVariableGet(peak_name):MathMax(balance,equity);
   if(equity>risk_peak)risk_peak=equity;
   GlobalVariableSet(peak_name,risk_peak);
   risk_existing=0;risk_stops=history_ok;
   for(int i=0;i<PositionsTotal();i++) {
      if(PositionGetTicket(i)==0){risk_stops=false;continue;}
      string symbol=PositionGetString(POSITION_SYMBOL);double stop=PositionGetDouble(POSITION_SL),loss=0;
      ENUM_ORDER_TYPE side=PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY?ORDER_TYPE_BUY:ORDER_TYPE_SELL;
      MqlTick quote;
      if(stop<=0 || !FreshQuote(symbol,quote,3) || !OrderCalcProfit(side,symbol,PositionGetDouble(POSITION_VOLUME),side==ORDER_TYPE_BUY?quote.bid:quote.ask,stop,loss)){risk_stops=false;continue;}
      risk_existing+=MathMax(0,-loss)+(symbol==_Symbol && costs_verified?commission_per_lot*PositionGetDouble(POSITION_VOLUME):0);
   }
   if(!history_ok || risk_day_start<=0){risk_stops=false;risk_day_start=MathMax(0.01,balance);risk_daily_loss=risk_day_start;}
}
bool TradeAllowed() {
   return TerminalInfoInteger(TERMINAL_CONNECTED) && TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && MQLInfoInteger(MQL_TRADE_ALLOWED) && AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) && AccountInfoInteger(ACCOUNT_TRADE_EXPERT);
}
bool TradingSessionOpen(string symbol){
   MqlDateTime now;if(!TimeToStruct(BrokerNow(),now))return false;
   int seconds=now.hour*3600+now.min*60+now.sec;
   // Overnight sessions belong to their starting weekday. Missing broker sessions fail closed.
   for(int back=0;back<2;back++)for(uint index=0;index<32;index++){
      datetime from=0,to=0;
      if(!SymbolInfoSessionTrade(symbol,(ENUM_DAY_OF_WEEK)((now.day_of_week+7-back)%7),index,from,to))break;
      int start=(int)((long)from%86400),end=(int)((long)to%86400);
      if((long)to-(long)from>=86400){if(back==0)return true;continue;}
      if(start<end){if(back==0 && seconds>=start && seconds<end)return true;}
      else if(start>end){if((back==0 && seconds>=start) || (back==1 && seconds<end))return true;}
   }
   return false;
}
bool SymbolExecutionAllowed(string symbol,bool opening){
   long execution=SymbolInfoInteger(symbol,SYMBOL_TRADE_EXEMODE),orders=SymbolInfoInteger(symbol,SYMBOL_ORDER_MODE);
   if(SymbolInfoInteger(symbol,SYMBOL_TRADE_MODE)==SYMBOL_TRADE_MODE_DISABLED || execution<SYMBOL_TRADE_EXECUTION_REQUEST || execution>SYMBOL_TRADE_EXECUTION_EXCHANGE || (orders&SYMBOL_ORDER_MARKET)==0)return false;
   if(opening && ((orders&SYMBOL_ORDER_SL)==0 || (orders&SYMBOL_ORDER_TP)==0))return false;
   datetime starts=(datetime)SymbolInfoInteger(symbol,SYMBOL_START_TIME),expires=(datetime)SymbolInfoInteger(symbol,SYMBOL_EXPIRATION_TIME),now=BrokerNow();
   if((starts>0 && now<starts) || (expires>0 && now>=expires))return false;
   return TradingSessionOpen(symbol);
}
string SymbolExecutionSnapshot(string symbol){
   MqlTick quote;double point=SymbolInfoDouble(symbol,SYMBOL_POINT),tick=SymbolInfoDouble(symbol,SYMBOL_TRADE_TICK_SIZE);
   if(clock_anchor<=0 || !FreshQuote(symbol,quote,15) || point<=0 || tick<=0)return "";
   return "{\"timestamp\":"+IntegerToString((long)ServerNow())+",\"brokerTimestamp\":"+IntegerToString((long)BrokerNow()*1000)+",\"quoteTimestamp\":"+IntegerToString((long)quote.time*1000)+",\"bid\":"+DoubleToString(quote.bid,10)+",\"ask\":"+DoubleToString(quote.ask,10)+",\"point\":"+DoubleToString(point,10)+",\"tickSize\":"+DoubleToString(tick,10)+",\"volumeStep\":"+DoubleToString(SymbolInfoDouble(symbol,SYMBOL_VOLUME_STEP),8)+",\"minVolume\":"+DoubleToString(SymbolInfoDouble(symbol,SYMBOL_VOLUME_MIN),8)+",\"maxVolume\":"+DoubleToString(SymbolInfoDouble(symbol,SYMBOL_VOLUME_MAX),8)+",\"stopLevel\":"+IntegerToString(SymbolInfoInteger(symbol,SYMBOL_TRADE_STOPS_LEVEL))+",\"freezeLevel\":"+IntegerToString(SymbolInfoInteger(symbol,SYMBOL_TRADE_FREEZE_LEVEL))+",\"tradeAllowed\":"+(TradeAllowed()?"true":"false")+",\"sessionOpen\":"+(TradingSessionOpen(symbol)?"true":"false")+",\"symbolTradeMode\":"+IntegerToString(SymbolInfoInteger(symbol,SYMBOL_TRADE_MODE))+",\"tradeExecutionMode\":"+IntegerToString(SymbolInfoInteger(symbol,SYMBOL_TRADE_EXEMODE))+",\"orderMode\":"+IntegerToString(SymbolInfoInteger(symbol,SYMBOL_ORDER_MODE))+",\"fillingMode\":"+IntegerToString(SymbolInfoInteger(symbol,SYMBOL_FILLING_MODE))+"}";
}
string PositionsSnapshot(bool &available){
   available=false;int total=PositionsTotal();if(total>100)return "[]";
   string json="[";
   for(int i=0;i<total;i++){
      ulong ticket=PositionGetTicket(i);if(ticket==0)return "[]";
      string symbol=PositionGetString(POSITION_SYMBOL),origin="";
      bool integrity=PositionGetInteger(POSITION_MAGIC)==100061 && StringFind(PositionGetString(POSITION_COMMENT),"R1000:")==0 && PositionHistoryIntegrity((ulong)PositionGetInteger(POSITION_IDENTIFIER),origin);
      double price=PositionGetDouble(POSITION_PRICE_CURRENT);
      string execution=SymbolExecutionSnapshot(symbol);
      if(i>0)json+=",";
      json+="{\"ticket\":\""+TicketString(ticket)+"\",\"identifier\":\""+TicketString((ulong)PositionGetInteger(POSITION_IDENTIFIER))+"\",\"magic\":"+IntegerToString(PositionGetInteger(POSITION_MAGIC))+",\"comment\":\""+EscapeJson(PositionGetString(POSITION_COMMENT))+"\",\"originComment\":\""+EscapeJson(origin)+"\",\"ownedIntegrity\":"+(integrity?"true":"false")+",\"symbol\":\""+EscapeJson(symbol)+"\",\"side\":\""+(PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY?"BUY":"SELL")+"\",\"volume\":"+DoubleToString(PositionGetDouble(POSITION_VOLUME),8)+",\"open\":"+DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN),10)+",\"currentPrice\":"+(price>0?DoubleToString(price,10):"null")+",\"openedAt\":"+IntegerToString(PositionGetInteger(POSITION_TIME_MSC))+",\"stop\":"+DoubleToString(PositionGetDouble(POSITION_SL),10)+",\"takeProfit\":"+DoubleToString(PositionGetDouble(POSITION_TP),10)+",\"profit\":"+DoubleToString(PositionGetDouble(POSITION_PROFIT),8)+(execution!=""?",\"execution\":"+execution:"")+"}";
   }
   if(PositionsTotal()!=total)return "[]";
   available=true;return json+"]";
}
string PendingOrdersSnapshot(bool &available){
   available=false;int total=OrdersTotal();if(total>100)return "[]";
   string json="[";int written=0;
   for(int i=0;i<total;i++){
      ulong ticket=OrderGetTicket(i);if(ticket==0)return "[]";
      string comment=OrderGetString(ORDER_COMMENT);
      if(OrderGetInteger(ORDER_MAGIC)!=100061 || StringFind(comment,"R1000:")!=0 || StringLen(comment)!=30)continue;
      ENUM_ORDER_TYPE type=(ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      if(type!=ORDER_TYPE_BUY_LIMIT && type!=ORDER_TYPE_SELL_LIMIT && type!=ORDER_TYPE_BUY_STOP && type!=ORDER_TYPE_SELL_STOP && type!=ORDER_TYPE_BUY_STOP_LIMIT && type!=ORDER_TYPE_SELL_STOP_LIMIT)continue;
      if(written++>0)json+=",";
      bool buy=type==ORDER_TYPE_BUY_LIMIT || type==ORDER_TYPE_BUY_STOP || type==ORDER_TYPE_BUY_STOP_LIMIT;
      json+="{\"ticket\":\""+TicketString(ticket)+"\",\"symbol\":\""+EscapeJson(OrderGetString(ORDER_SYMBOL))+"\",\"side\":\""+(buy?"BUY":"SELL")+"\",\"type\":\""+EnumToString(type)+"\",\"volume\":"+DoubleToString(OrderGetDouble(ORDER_VOLUME_CURRENT),8)+",\"price\":"+DoubleToString(OrderGetDouble(ORDER_PRICE_OPEN),10)+",\"stop\":"+DoubleToString(OrderGetDouble(ORDER_SL),10)+",\"takeProfit\":"+DoubleToString(OrderGetDouble(ORDER_TP),10)+",\"createdAt\":"+IntegerToString(OrderGetInteger(ORDER_TIME_SETUP_MSC))+",\"magic\":100061,\"comment\":\""+EscapeJson(comment)+"\",\"originComment\":\""+EscapeJson(comment)+"\",\"ownedIntegrity\":true}";
   }
   if(OrdersTotal()!=total)return "[]";
   available=true;return json+"]";
}
string BrokerHistorySnapshot(){
   datetime to=BrokerNow(),from=to>30*86400?to-30*86400:0;
   string header="\"from\":"+IntegerToString((long)from*1000)+",\"to\":"+IntegerToString((long)to*1000+999)+",\"currency\":\""+EscapeJson(AccountInfoString(ACCOUNT_CURRENCY))+"\"";
   if(to<=0 || !HistorySelect(from,to) || HistoryDealsTotal()>10000)return "{\"available\":false,"+header+",\"deals\":[]}";
   // Capture deal rows before lineage verification: HistorySelectByPosition replaces MT5's history list.
   string rows[100];ulong identifiers[100];int count=0,total=HistoryDealsTotal();
   for(int i=total-1;i>=0 && count<100;i--){
      ulong deal=HistoryDealGetTicket(i);if(deal==0)return "{\"available\":false,"+header+",\"deals\":[]}";
      long type=HistoryDealGetInteger(deal,DEAL_TYPE),entry=HistoryDealGetInteger(deal,DEAL_ENTRY);
      if(HistoryDealGetInteger(deal,DEAL_MAGIC)!=100061 || (type!=DEAL_TYPE_BUY && type!=DEAL_TYPE_SELL))continue;
      identifiers[count]=(ulong)HistoryDealGetInteger(deal,DEAL_POSITION_ID);
      string entry_name=entry==DEAL_ENTRY_IN?"IN":(entry==DEAL_ENTRY_OUT?"OUT":(entry==DEAL_ENTRY_OUT_BY?"OUT_BY":"INOUT"));
      rows[count]="{\"ticket\":\""+TicketString(deal)+"\",\"deal\":\""+TicketString(deal)+"\",\"order\":\""+TicketString((ulong)HistoryDealGetInteger(deal,DEAL_ORDER))+"\",\"positionIdentifier\":\""+TicketString(identifiers[count])+"\",\"symbol\":\""+EscapeJson(HistoryDealGetString(deal,DEAL_SYMBOL))+"\",\"side\":\""+(type==DEAL_TYPE_BUY?"BUY":"SELL")+"\",\"entry\":\""+entry_name+"\",\"reason\":\""+EnumToString((ENUM_DEAL_REASON)HistoryDealGetInteger(deal,DEAL_REASON))+"\",\"volume\":"+DoubleToString(HistoryDealGetDouble(deal,DEAL_VOLUME),8)+",\"price\":"+DoubleToString(HistoryDealGetDouble(deal,DEAL_PRICE),10)+",\"profit\":"+DoubleToString(HistoryDealGetDouble(deal,DEAL_PROFIT),8)+",\"commission\":"+DoubleToString(HistoryDealGetDouble(deal,DEAL_COMMISSION),8)+",\"swap\":"+DoubleToString(HistoryDealGetDouble(deal,DEAL_SWAP),8)+",\"fee\":"+DoubleToString(HistoryDealGetDouble(deal,DEAL_FEE),8)+",\"time\":"+IntegerToString(HistoryDealGetInteger(deal,DEAL_TIME_MSC))+",\"magic\":100061,\"comment\":\""+EscapeJson(HistoryDealGetString(deal,DEAL_COMMENT))+"\"";
      count++;
   }
   string deals="[";int written=0;
   for(int i=0;i<count;i++){
      string origin="";if(!PositionHistoryIntegrity(identifiers[i],origin))continue;
      if(written++>0)deals+=",";
      deals+=rows[i]+",\"originComment\":\""+EscapeJson(origin)+"\",\"ownedIntegrity\":true}";
   }
   return "{\"available\":true,"+header+",\"limit\":100,\"deals\":"+deals+"]}";
}
string CachePerformance(string snapshot,bool available){
   performance_cache=snapshot;performance_account=AccountStamp();
   performance_until=GetTickCount64()+(ulong)(available?60000:10000);
   return snapshot;
}
string PerformanceUnavailable(datetime from,datetime to,string reason){
   if(GetTickCount64()>=performance_notice){Print("ROCKET1000 EA: broker performance history unavailable - ",reason);performance_notice=GetTickCount64()+60000;}
   // Unavailable history has no numeric totals: it must never look like a verified zero result.
   return CachePerformance("{\"available\":false,\"from\":"+IntegerToString((long)from*1000)+",\"to\":"+IntegerToString((long)to*1000)+",\"currency\":\""+EscapeJson(AccountInfoString(ACCOUNT_CURRENCY))+"\"}",false);
}
struct PerformanceDeal {
   ulong identifier;
   long type;
   long entry;
   double profit;
   double net;
};
string PerformanceSnapshot(){
   if(performance_cache!="" && performance_account==AccountStamp() && GetTickCount64()<performance_until)return performance_cache;
   datetime to=BrokerNow(),from=to>30*86400?to-30*86400:0;
   if(to<=0 || !HistorySelect(from,to))return PerformanceUnavailable(from,to,"30-day HistorySelect failed");
   int total=HistoryDealsTotal();
   if(total>10000)return PerformanceUnavailable(from,to,"30-day broker history exceeds the 10000-deal processing limit");
   PerformanceDeal rows[];if(ArrayResize(rows,total)!=total)return PerformanceUnavailable(from,to,"could not allocate broker history");
   int count=0;
   for(int i=0;i<total;i++){
      ulong deal=HistoryDealGetTicket(i);long magic=0,type=0,entry=0;
      if(deal==0 || !HistoryDealGetInteger(deal,DEAL_MAGIC,magic))return PerformanceUnavailable(from,to,"broker deal could not be read");
      // Capture first: checking full position lineage changes MT5's selected history list.
      if(magic!=100061)continue;
      double profit=0,commission=0,swap=0,fee=0;
      if(!HistoryDealGetInteger(deal,DEAL_TYPE,type) || !HistoryDealGetInteger(deal,DEAL_ENTRY,entry) || !HistoryDealGetDouble(deal,DEAL_PROFIT,profit) || !HistoryDealGetDouble(deal,DEAL_COMMISSION,commission) || !HistoryDealGetDouble(deal,DEAL_SWAP,swap) || !HistoryDealGetDouble(deal,DEAL_FEE,fee) || !MathIsValidNumber(profit) || !MathIsValidNumber(commission) || !MathIsValidNumber(swap) || !MathIsValidNumber(fee))return PerformanceUnavailable(from,to,"broker deal totals could not be verified");
      rows[count].identifier=(ulong)HistoryDealGetInteger(deal,DEAL_POSITION_ID);
      if(rows[count].identifier==0)return PerformanceUnavailable(from,to,"strategy fees lack verifiable position ownership");
      rows[count].type=type;rows[count].entry=entry;rows[count].profit=profit;rows[count].net=profit+commission+swap+fee;count++;
   }
   ulong lineage_ids[];bool lineage_valid[];
   if(ArrayResize(lineage_ids,count)!=count || ArrayResize(lineage_valid,count)!=count)return PerformanceUnavailable(from,to,"could not allocate ownership verification");
   int lineages=0,closed=0,wins=0,losses=0;double gross_profit=0,gross_loss=0,net=0;
   for(int i=0;i<count;i++){
      int known=-1;
      for(int n=0;n<lineages;n++)if(lineage_ids[n]==rows[i].identifier){known=n;break;}
      if(known<0){string origin;known=lineages++;lineage_ids[known]=rows[i].identifier;lineage_valid[known]=PositionHistoryIntegrity(rows[i].identifier,origin);}
      if(!lineage_valid[known])continue;
      net+=rows[i].net;
      if((rows[i].type==DEAL_TYPE_BUY || rows[i].type==DEAL_TYPE_SELL) && (rows[i].entry==DEAL_ENTRY_OUT || rows[i].entry==DEAL_ENTRY_OUT_BY)){
         closed++;gross_profit+=MathMax(0,rows[i].profit);gross_loss+=MathMax(0,-rows[i].profit);
         if(rows[i].net>0)wins++;else if(rows[i].net<0)losses++;
      }
   }
   if(!MathIsValidNumber(net) || !MathIsValidNumber(gross_profit) || !MathIsValidNumber(gross_loss))return PerformanceUnavailable(from,to,"non-finite broker totals");
   return CachePerformance("{\"available\":true,\"from\":"+IntegerToString((long)from*1000)+",\"to\":"+IntegerToString((long)to*1000)+",\"closedDeals\":"+IntegerToString(closed)+",\"wins\":"+IntegerToString(wins)+",\"losses\":"+IntegerToString(losses)+",\"grossProfit\":"+DoubleToString(gross_profit,8)+",\"grossLoss\":"+DoubleToString(gross_loss,8)+",\"netProfit\":"+DoubleToString(net,8)+",\"currency\":\""+EscapeJson(AccountInfoString(ACCOUNT_CURRENCY))+"\"}",true);
}
string ExecutionSnapshot() {
   RefreshRisk();
   double tick_value=MathMax(SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE_LOSS),SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_VALUE_PROFIT));
   string account="{\"balance\":"+DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE),2)+",\"equity\":"+DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY),2)+",\"currency\":\""+EscapeJson(AccountInfoString(ACCOUNT_CURRENCY))+"\",\"brokerName\":\""+EscapeJson(AccountInfoString(ACCOUNT_COMPANY))+"\",\"dailyProfitLoss\":"+(daily_history_verified?DoubleToString(realized_today+AccountInfoDouble(ACCOUNT_PROFIT),2):"null")+"}";
   account=StringSubstr(account,0,StringLen(account)-1)+",\"margin\":"+DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN),2)+",\"freeMargin\":"+DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE),2)+",\"marginLevel\":"+DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_LEVEL),2)+",\"floatingProfit\":"+DoubleToString(AccountInfoDouble(ACCOUNT_PROFIT),2)+",\"positionsCount\":"+IntegerToString(PositionsTotal())+",\"ordersCount\":"+IntegerToString(OrdersTotal())+"}";
   return "{\"engineVersion\":\"rocket-ai-6\",\"accountMarginMode\":"+IntegerToString(AccountInfoInteger(ACCOUNT_MARGIN_MODE))+",\"account\":"+account+",\"positionsAvailable\":"+(positions_available?"true":"false")+",\"positions\":"+positions_snapshot+",\"brokerPendingAvailable\":"+(broker_pending_available?"true":"false")+",\"brokerPending\":"+broker_pending_snapshot+",\"tradeHistory\":"+BrokerHistorySnapshot()+",\"sessionOpen\":"+(TradingSessionOpen(_Symbol)?"true":"false")+",\"symbolTradeMode\":"+IntegerToString(SymbolInfoInteger(_Symbol,SYMBOL_TRADE_MODE))+",\"tradeExecutionMode\":"+IntegerToString(SymbolInfoInteger(_Symbol,SYMBOL_TRADE_EXEMODE))+",\"orderMode\":"+IntegerToString(SymbolInfoInteger(_Symbol,SYMBOL_ORDER_MODE))+",\"fillingMode\":"+IntegerToString(SymbolInfoInteger(_Symbol,SYMBOL_FILLING_MODE))+",\"performance\":"+PerformanceSnapshot()+",\"tickSize\":"+DoubleToString(SymbolInfoDouble(_Symbol,SYMBOL_TRADE_TICK_SIZE),10)+",\"tickValue\":"+DoubleToString(tick_value,8)+",\"point\":"+DoubleToString(_Point,10)+",\"volumeStep\":"+DoubleToString(SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_STEP),8)+",\"minVolume\":"+DoubleToString(SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MIN),8)+",\"maxVolume\":"+DoubleToString(SymbolInfoDouble(_Symbol,SYMBOL_VOLUME_MAX),8)+",\"stopLevel\":"+IntegerToString(SymbolInfoInteger(_Symbol,SYMBOL_TRADE_STOPS_LEVEL))+",\"commissionPerLot\":"+DoubleToString(commission_per_lot,8)+",\"costsVerified\":"+(costs_verified?"true":"false")+",\"consecutiveLosses\":"+IntegerToString(consecutive_losses)+",\"consecutiveLossesVerified\":"+(loss_history_verified?"true":"false")+",\"dayStartEquity\":"+DoubleToString(risk_day_start,2)+",\"dailyLoss\":"+DoubleToString(risk_daily_loss,2)+",\"peakEquity\":"+DoubleToString(risk_peak,2)+",\"existingRisk\":"+DoubleToString(risk_existing,2)+",\"pendingOrders\":"+IntegerToString(OrdersTotal())+",\"freeMargin\":"+DoubleToString(MathMax(0,AccountInfoDouble(ACCOUNT_MARGIN_FREE)),2)+",\"tradeAllowed\":"+(TradeAllowed()?"true":"false")+",\"stopsVerified\":"+(risk_stops?"true":"false")+",\"newsVerified\":"+(news_verified?"true":"false")+",\"newsBlocked\":"+(news_blocked?"true":"false")+"}";
}
string TelemetryBody() {
   ENUM_ACCOUNT_TRADE_MODE mode=(ENUM_ACCOUNT_TRADE_MODE)AccountInfoInteger(ACCOUNT_TRADE_MODE);
   if(mode!=ACCOUNT_TRADE_MODE_REAL && mode!=ACCOUNT_TRADE_MODE_DEMO)return "";
   string account_type=(mode==ACCOUNT_TRADE_MODE_DEMO?"demo":"live");
   bool broker_connected=(bool)TerminalInfoInteger(TERMINAL_CONNECTED);
   string json="{\"accountLogin\":\""+IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))+"\",\"brokerServer\":\""+EscapeJson(AccountInfoString(ACCOUNT_SERVER))+"\",\"accountType\":\""+account_type+"\",\"accountTradeMode\":"+IntegerToString((long)mode)+",\"chartSymbol\":\""+EscapeJson(_Symbol)+"\",\"authorizedSymbols\":[\""+EscapeJson(_Symbol)+"\"],\"instanceId\":\""+ea_instance+"\",\"eaVersion\":\"6.00\",\"terminalBuild\":"+IntegerToString(TerminalInfoInteger(TERMINAL_BUILD))+",\"brokerConnected\":"+(broker_connected?"true":"false")+"}";
   // Position/account synchronization must continue when chart candles or quotes are unavailable.
   positions_snapshot=PositionsSnapshot(positions_available);
   broker_pending_snapshot=PendingOrdersSnapshot(broker_pending_available);
   string market=MarketSnapshot();
   if(market!="")json=StringSubstr(json,0,StringLen(json)-1)+",\"market\":"+market+"}";
   string execution=ExecutionSnapshot();execution=StringSubstr(execution,0,StringLen(execution)-1)+",\"terminalId\":\""+terminal_id+"\",\"realizedToday\":"+DoubleToString(realized_today,2)+",\"freezeLevel\":"+IntegerToString(SymbolInfoInteger(_Symbol,SYMBOL_TRADE_FREEZE_LEVEL))+"}";
   json=StringSubstr(json,0,StringLen(json)-1)+",\"eaProtocol\":4,\"terminalSession\":\""+terminal_session+"\",\"execution\":"+execution+(pending_result!=""?",\"orderResult\":"+pending_result:"")+"}";
   return json;
}
int Post(string path,string json,string &body) {
   if(json=="")return -2;
   char data[],result[];string response_headers;
   int size=StringToCharArray(json,data,0,WHOLE_ARRAY,CP_UTF8);
   if(size<2) return -1;
   ArrayResize(data,size-1); // no terminating NUL in the JSON HTTP body
   ResetLastError();
   int code=WebRequest("POST",backend_url+path,"Content-Type: application/json\r\nAuthorization: Bearer "+credential+"\r\n",5000,data,result,response_headers);
   if(code==-1) {
      int error=GetLastError();
      if(error==4014) ShowStatus("Disconnected - approve WebRequest permission for the address shown");
      else ShowStatus("Disconnected - HTTPS/network error "+IntegerToString(error));
      return -1;
   }
   // A 200 HTML login page or proxy response is never a successful registration.
   if(code==200) {
      body=CharArrayToString(result,0,WHOLE_ARRAY,CP_UTF8);
      if(StringFind(body,"\"ok\":true")<0 || StringFind(body,"\"installationId\":\""+installation_id+"\"")<0) return 502;
      double server_time=StringToDouble(JsonValue(body,"serverTime",false));
      if(server_time<1577836800000.0 || server_time>4102444800000.0)return 502;
      clock_anchor=server_time;clock_tick=GetTickCount64();
   }
   return code;
}
string JsonValue(string json,string key,bool quoted) {
   string marker="\""+key+"\":";int from=StringFind(json,marker);if(from<0)return "";from+=StringLen(marker);
   if(quoted){if(StringSubstr(json,from,1)!="\"")return "";from++;int to=StringFind(json,"\"",from);if(to<from)return "";return StringSubstr(json,from,to-from);}
   int to=from;while(to<StringLen(json) && StringFind("0123456789.eE+-",StringSubstr(json,to,1))>=0)to++;
   return StringSubstr(json,from,to-from);
}
string TicketString(ulong value){return StringFormat("%I64u",value);}
ulong TicketValue(string value){
   if(StringLen(value)<1 || StringLen(value)>20)return 0;
   ulong parsed=0;
   for(int i=0;i<StringLen(value);i++){ushort c=StringGetCharacter(value,i);if(c<'0'||c>'9')return 0;ulong next=parsed*10+(ulong)(c-'0');if(next/10!=parsed)return 0;parsed=next;}
   return parsed;
}
bool SameAccount(string body){
   long mode=AccountInfoInteger(ACCOUNT_TRADE_MODE);
   string type=mode==ACCOUNT_TRADE_MODE_REAL?"live":(mode==ACCOUNT_TRADE_MODE_DEMO?"demo":"invalid");
   return account_stamp==AccountStamp() && JsonValue(body,"accountLogin",true)==IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) && JsonValue(body,"brokerServer",true)==AccountInfoString(ACCOUNT_SERVER) && JsonValue(body,"accountType",true)==type && type!="invalid";
}
void BrokerResult(string id,string lease,string status,uint code,ulong deal=0,ulong order=0,double volume=0,double price=0,string evidence=""){
   if(deal>0)performance_until=0;
   pending_result="{\"id\":\""+id+"\",\"lease\":\""+lease+"\",\"status\":\""+status+"\",\"retcode\":"+IntegerToString(code)+",\"deal\":\""+TicketString(deal)+"\",\"order\":\""+TicketString(order)+"\",\"filledVolume\":"+DoubleToString(volume,8)+",\"filledPrice\":"+DoubleToString(price,10)+",\"reconciled\":"+(evidence!=""?"true":"false")+",\"evidence\":\""+evidence+"\"}";
   Print("ROCKET1000 EA: ",id," ",status,"; broker code ",code,"; deal ",TicketString(deal),"; order ",TicketString(order));
}
bool SetFilling(MqlTradeRequest &request){
   long filling=SymbolInfoInteger(request.symbol,SYMBOL_FILLING_MODE);
   if((filling&SYMBOL_FILLING_FOK)!=0)request.type_filling=ORDER_FILLING_FOK;
   else if((filling&SYMBOL_FILLING_IOC)!=0)request.type_filling=ORDER_FILLING_IOC;
   else if(SymbolInfoInteger(request.symbol,SYMBOL_TRADE_EXEMODE)!=SYMBOL_TRADE_EXECUTION_MARKET)request.type_filling=ORDER_FILLING_RETURN;
   else return false;
   return true;
}
bool SafeOrder(string body,MqlTradeRequest &request){
   if(!registered || !order_permission || clock_anchor<=0 || !TradeAllowed() || !SameAccount(body))return false;
   if(JsonValue(body,"engineVersion",true)!="rocket-ai-6")return false;
   double expiry=StringToDouble(JsonValue(body,"expiresAt",false));
   if(expiry<=ServerNow() || expiry>ServerNow()+60000)return false;
   string kind=JsonValue(body,"kind",true),symbol=JsonValue(body,"symbol",true),side=JsonValue(body,"side",true);
   if((kind=="OPEN" || kind=="MODIFY") && (JsonValue(body,"source",true)!="ai" || StringLen(JsonValue(body,"analysisId",true))!=36))return false;
   if((kind=="OPEN" && symbol!=_Symbol) || (side!="BUY" && side!="SELL") || (kind!="OPEN" && kind!="MODIFY" && kind!="CLOSE"))return false;
   double volume=StringToDouble(JsonValue(body,"volume",false)),stop=StringToDouble(JsonValue(body,"stop",false)),tp=StringToDouble(JsonValue(body,"takeProfit",false)),review=StringToDouble(JsonValue(body,"entry",false));
   double spread_cap=StringToDouble(JsonValue(body,"maxSpread",false)),slippage_cap=StringToDouble(JsonValue(body,"maxSlippage",false));
   double risk_pct=StringToDouble(JsonValue(body,"riskPerTradePct",false)),daily_pct=StringToDouble(JsonValue(body,"maxDailyLossPct",false)),drawdown_pct=StringToDouble(JsonValue(body,"maxDrawdownPct",false)),position_limit=StringToDouble(JsonValue(body,"maxPositions",false));
   if(volume<=0 || review<=0 || spread_cap<1 || spread_cap>1000 || slippage_cap<1 || slippage_cap>1000 || risk_pct<=0 || risk_pct>0.25 || daily_pct<=0 || daily_pct>1 || drawdown_pct<=0 || drawdown_pct>5 || position_limit!=1)return false;
   MqlTick quote;if(!FreshQuote(symbol,quote,3))return false;
   double step=SymbolInfoDouble(symbol,SYMBOL_VOLUME_STEP),tick=SymbolInfoDouble(symbol,SYMBOL_TRADE_TICK_SIZE),point=SymbolInfoDouble(symbol,SYMBOL_POINT);
   if(point<=0 || !SymbolExecutionAllowed(symbol,kind=="OPEN"))return false;
   if(step<=0 || tick<=0 || MathAbs(volume/step-MathRound(volume/step))>0.000001)return false;
   // Minimum new-order volume must not strand a broker-confirmed residual after a partial fill.
   if(kind=="OPEN" && (volume<SymbolInfoDouble(symbol,SYMBOL_VOLUME_MIN) || volume>SymbolInfoDouble(symbol,SYMBOL_VOLUME_MAX)))return false;
   ZeroMemory(request);request.symbol=symbol;request.magic=100061;request.deviation=(ulong)slippage_cap;request.type_time=ORDER_TIME_GTC;
   if(kind=="MODIFY" || kind=="CLOSE"){
      ulong position=TicketValue(JsonValue(body,"position",true));
      double expected_volume=StringToDouble(JsonValue(body,"positionVolume",false));
      if(position==0 || !PositionSelectByTicket(position) || !PositionIntegrity() || PositionGetString(POSITION_SYMBOL)!=symbol || PositionGetString(POSITION_COMMENT)!=JsonValue(body,"positionComment",true) || TicketString((ulong)PositionGetInteger(POSITION_IDENTIFIER))!=JsonValue(body,"positionIdentifier",true) || expected_volume<=0 || MathAbs(PositionGetDouble(POSITION_VOLUME)-expected_volume)>0.00000001)return false;
      if(kind=="MODIFY" && MathAbs(volume-expected_volume)>0.00000001)return false;
      if(kind=="CLOSE"){
         double remaining=expected_volume-volume,min_volume=SymbolInfoDouble(symbol,SYMBOL_VOLUME_MIN);
         bool partial=StringFind(body,"\"partialClose\":true")>=0;
         if(volume>expected_volume+0.00000001 || (partial?(remaining<=0 || volume<min_volume || volume>SymbolInfoDouble(symbol,SYMBOL_VOLUME_MAX) || remaining+0.00000001<min_volume || MathAbs(remaining/step-MathRound(remaining/step))>0.000001):MathAbs(remaining)>0.00000001))return false;
      }
      bool buy=PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY;
      if((buy?"BUY":"SELL")!=side)return false;
      request.position=position;
      if(kind=="MODIFY"){
         double existing=PositionGetDouble(POSITION_SL),distance=(double)MathMax(SymbolInfoInteger(symbol,SYMBOL_TRADE_STOPS_LEVEL),SymbolInfoInteger(symbol,SYMBOL_TRADE_FREEZE_LEVEL))*point;
         if(stop<=0 || tp<=0 || MathAbs(stop/tick-MathRound(stop/tick))>0.00001 || MathAbs(tp/tick-MathRound(tp/tick))>0.00001)return false;
         if(buy?((existing>0 && stop<existing) || stop>=quote.bid-distance || tp<=quote.ask+distance):((existing>0 && stop>existing) || stop<=quote.ask+distance || tp>=quote.bid-distance))return false;
         request.action=TRADE_ACTION_SLTP;request.sl=stop;request.tp=tp;
      }else{
         double freeze=(double)SymbolInfoInteger(symbol,SYMBOL_TRADE_FREEZE_LEVEL)*point;
         double current_stop=PositionGetDouble(POSITION_SL),current_tp=PositionGetDouble(POSITION_TP),close_price=buy?quote.bid:quote.ask;
         if(freeze>0 && ((current_stop>0 && MathAbs(close_price-current_stop)<=freeze) || (current_tp>0 && MathAbs(close_price-current_tp)<=freeze)))return false;
         if(MathAbs((buy?quote.bid:quote.ask)-review)>slippage_cap*point)return false;
         request.action=TRADE_ACTION_DEAL;request.type=buy?ORDER_TYPE_SELL:ORDER_TYPE_BUY;request.volume=volume;request.price=buy?quote.bid:quote.ask;
         if(!SetFilling(request))return false;
      }
   }else{
      RefreshRisk();
      if(!FreshQuote(symbol,quote,3))return false;
      if(!risk_stops || !news_verified || news_blocked || !loss_history_verified || consecutive_losses>=3 || PositionsTotal()>=(int)position_limit || OrdersTotal()>0 || !costs_verified)return false;
      // One account position during initial testing: no grid, baskets, additions or averaging down.
      if(PositionsTotal()!=0)return false;
      double aggregate_pct=StringToDouble(JsonValue(body,"aggregateRiskPct",false)),min_rr=StringToDouble(JsonValue(body,"minRewardRisk",false));
      if(aggregate_pct<=0 || aggregate_pct>0.25 || (min_rr<1.5 || min_rr>10))return false;
      double balance=AccountInfoDouble(ACCOUNT_BALANCE),equity=AccountInfoDouble(ACCOUNT_EQUITY),capital=MathMin(balance,equity),entry=side=="BUY"?quote.ask:quote.bid;
      if(capital<=0 || risk_daily_loss>=risk_day_start*daily_pct/100 || risk_peak<=0 || (risk_peak-equity)/risk_peak>=drawdown_pct/100 || (quote.ask-quote.bid)/point>spread_cap+0.00001 || MathAbs(entry-review)>slippage_cap*point)return false;
      if(stop<=0 || tp<=0 || MathAbs(stop/tick-MathRound(stop/tick))>0.00001 || MathAbs(tp/tick-MathRound(tp/tick))>0.00001)return false;
      double distance=(double)MathMax(SymbolInfoInteger(symbol,SYMBOL_TRADE_STOPS_LEVEL),SymbolInfoInteger(symbol,SYMBOL_TRADE_FREEZE_LEVEL))*point;
      if(side=="BUY"?(stop>=quote.bid-distance || tp<=quote.ask+distance):(stop<=quote.ask+distance || tp>=quote.bid-distance))return false;
      ENUM_SYMBOL_TRADE_MODE mode=(ENUM_SYMBOL_TRADE_MODE)SymbolInfoInteger(symbol,SYMBOL_TRADE_MODE);
      if(mode!=SYMBOL_TRADE_MODE_FULL && !(side=="BUY" && mode==SYMBOL_TRADE_MODE_LONGONLY) && !(side=="SELL" && mode==SYMBOL_TRADE_MODE_SHORTONLY))return false;
      ENUM_ORDER_TYPE type=side=="BUY"?ORDER_TYPE_BUY:ORDER_TYPE_SELL;double loss=0,reward=0,margin=0,worst=entry+(side=="BUY"?slippage_cap:-slippage_cap)*point;
      // Ask/Bid entry already includes the spread. Add both adverse entry/exit slippage and observed round-trip commission.
      double worst_stop=stop+(side=="BUY"?-slippage_cap:slippage_cap)*point;
      double worst_tp=tp+(side=="BUY"?-slippage_cap:slippage_cap)*point;
      if(worst_stop<=0 || worst_tp<=0 || !OrderCalcProfit(type,symbol,volume,worst,worst_stop,loss) || !OrderCalcProfit(type,symbol,volume,worst,worst_tp,reward) || loss>=0)return false;
      double cost=commission_per_lot*volume,total_risk=-loss+cost,net_reward=reward-cost;
      if(!MathIsValidNumber(total_risk) || !MathIsValidNumber(net_reward) || total_risk<=0 || net_reward<=0 || total_risk>capital*risk_pct/100 || risk_existing+total_risk>capital*aggregate_pct/100 || net_reward/total_risk+0.000001<min_rr)return false;
      if(!OrderCalcMargin(type,symbol,volume,worst,margin) || !MathIsValidNumber(margin) || margin<0 || margin>AccountInfoDouble(ACCOUNT_MARGIN_FREE))return false;
      request.action=TRADE_ACTION_DEAL;request.type=type;request.volume=volume;request.price=entry;request.sl=stop;request.tp=tp;
      if(!SetFilling(request))return false;
   }
   MqlTradeCheckResult checked={};
   if(!OrderCheck(request,checked) || checked.retcode!=0 || checked.margin_free<0)return false;
   return true;
}
void ExecuteBrokerCommand(string body){
   string id=JsonValue(body,"orderId",true),lease=JsonValue(body,"lease",true),kind=JsonValue(body,"kind",true);
   if(StringLen(id)!=36 || StringLen(lease)!=43 || !SameAccount(body))return;
   string guard="R1000.sent."+id;
   if(GlobalVariableCheck(guard)){BrokerResult(id,lease,"uncertain",0);return;}
   MqlTradeRequest request={};
   if(!SafeOrder(body,request)){BrokerResult(id,lease,"failed",0);return;}
   string json=TelemetryBody(),authorized="";
   json=StringSubstr(json,0,StringLen(json)-1)+",\"authorization\":{\"id\":\""+id+"\",\"lease\":\""+lease+"\"}}";
   if(Post("/api/ea/authorize",json,authorized)!=200 || JsonValue(authorized,"command",true)!="AUTHORIZED" || JsonValue(authorized,"orderId",true)!=id || JsonValue(authorized,"lease",true)!=lease){BrokerResult(id,lease,"failed",0);return;}
   if(!SafeOrder(authorized,request)){BrokerResult(id,lease,"failed",0);return;}
   ResetLastError();if(GlobalVariableSet(guard,ServerNow())==0 || GetLastError()!=0){BrokerResult(id,lease,"failed",0);return;}
   ResetLastError();GlobalVariablesFlush();if(GetLastError()!=0){BrokerResult(id,lease,"failed",0);return;}
   if(!SameAccount(authorized) || (request.position>0 && (!PositionSelectByTicket(request.position) || !PositionIntegrity() || TicketString((ulong)PositionGetInteger(POSITION_IDENTIFIER))!=JsonValue(authorized,"positionIdentifier",true) || MathAbs(PositionGetDouble(POSITION_VOLUME)-StringToDouble(JsonValue(authorized,"positionVolume",false)))>0.00000001))){BrokerResult(id,lease,"failed",0);return;}
   request.comment="R1000:"+StringSubstr(id,0,24);
   active_id=id;active_lease=lease;active_kind=kind;active_symbol=request.symbol;active_position=request.position;active_identifier=JsonValue(authorized,"positionIdentifier",true);
   active_order=0;active_volume=request.volume;active_filled=0;active_value=0;active_stop=request.sl;active_tp=request.tp;active_deal_count=0;
   MqlTradeResult result={};bool sent=OrderSend(request,result);string status="uncertain";
   active_order=result.order;
   // OrderSend acceptance is not a fill. OnTradeTransaction/broker history confirm actual execution.
   if(status=="uncertain" && result.retcode!=0 && result.retcode!=TRADE_RETCODE_TIMEOUT && result.retcode!=TRADE_RETCODE_PLACED && result.retcode!=TRADE_RETCODE_CONNECTION && result.retcode!=TRADE_RETCODE_DONE && result.retcode!=TRADE_RETCODE_DONE_PARTIAL)status="failed";
   if(!sent && result.retcode==0)Print("ROCKET1000 EA: OrderSend did not confirm a broker response; command remains uncertain.");
   BrokerResult(id,lease,status,result.retcode,0,result.order,0,0);
   if(status=="failed")active_id="";
}
void ReconcileBrokerCommand(string body){
   string id=JsonValue(body,"orderId",true),lease=JsonValue(body,"lease",true),kind=JsonValue(body,"kind",true),symbol=JsonValue(body,"symbol",true);
   if(StringLen(id)!=36 || StringLen(lease)!=43 || !SameAccount(body) || (kind=="OPEN" && symbol!=_Symbol))return;
   string tag="R1000:"+StringSubstr(id,0,24);
   if(kind=="MODIFY"){
      ulong position=TicketValue(JsonValue(body,"position",true));double tick=SymbolInfoDouble(symbol,SYMBOL_TRADE_TICK_SIZE);
      if(position>0 && PositionSelectByTicket(position) && PositionGetString(POSITION_SYMBOL)==symbol && PositionIntegrity() && TicketString((ulong)PositionGetInteger(POSITION_IDENTIFIER))==JsonValue(body,"positionIdentifier",true) && MathAbs(PositionGetDouble(POSITION_SL)-StringToDouble(JsonValue(body,"stop",false)))<tick/2 && MathAbs(PositionGetDouble(POSITION_TP)-StringToDouble(JsonValue(body,"takeProfit",false)))<tick/2){BrokerResult(id,lease,"executed",0,0,0,0,0,"position-state");return;}
   }else if(HistorySelect(BrokerNow()-7*86400,BrokerNow())){
      double volume=0,value=0;ulong deal=0,order=0;
      for(int n=0;n<HistoryDealsTotal();n++){
         ulong candidate=HistoryDealGetTicket(n);if(candidate==0)continue;
         ulong candidate_order=(ulong)HistoryDealGetInteger(candidate,DEAL_ORDER);
         long type=HistoryDealGetInteger(candidate,DEAL_TYPE);
         if((type!=DEAL_TYPE_BUY && type!=DEAL_TYPE_SELL) || HistoryDealGetInteger(candidate,DEAL_MAGIC)!=100061 || HistoryDealGetString(candidate,DEAL_SYMBOL)!=symbol)continue;
         long entry=HistoryDealGetInteger(candidate,DEAL_ENTRY);
         if((kind=="OPEN" && entry!=DEAL_ENTRY_IN) || (kind=="CLOSE" && (entry!=DEAL_ENTRY_OUT && entry!=DEAL_ENTRY_OUT_BY)))continue;
         if(kind=="CLOSE" && TicketString((ulong)HistoryDealGetInteger(candidate,DEAL_POSITION_ID))!=JsonValue(body,"positionIdentifier",true))continue;
         if(HistoryDealGetString(candidate,DEAL_COMMENT)!=tag && HistoryOrderGetString(candidate_order,ORDER_COMMENT)!=tag)continue;
         double filled=HistoryDealGetDouble(candidate,DEAL_VOLUME);volume+=filled;value+=filled*HistoryDealGetDouble(candidate,DEAL_PRICE);deal=candidate;order=candidate_order;
      }
      bool pending=false;for(int n=0;n<OrdersTotal();n++){ulong ticket=OrderGetTicket(n);if(ticket>0 && OrderGetInteger(ORDER_MAGIC)==100061 && OrderGetString(ORDER_COMMENT)==tag)pending=true;}
      if(volume>0 && !pending){bool partial=volume+0.00000001<StringToDouble(JsonValue(body,"volume",false));BrokerResult(id,lease,partial?"partial":"executed",0,deal,order,volume,value/volume,"broker-history");return;}
   }
   // Missing local guard on the SAME persistent terminal proves OrderSend was never reached.
   double age=ServerNow()-StringToDouble(JsonValue(body,"createdAt",false));
   if(age>=0 && age<7*86400000.0 && JsonValue(body,"originTerminal",true)==terminal_id && !GlobalVariableCheck("R1000.sent."+id)){BrokerResult(id,lease,"failed",0);return;}
   BrokerResult(id,lease,"uncertain",0);
}
int SendTelemetry(bool registration){
   string body="";int code=Post(registration?"/api/ea/register":"/api/ea/heartbeat",TelemetryBody(),body);
   if(code==200){pending_result="";active_id="";order_permission=StringFind(body,"\"tradingEnabled\":true")>=0;registered=true;string command=JsonValue(body,"command",true);if(command=="TRADE")ExecuteBrokerCommand(body);else if(command=="RECONCILE")ReconcileBrokerCommand(body);}
   else order_permission=false;
   return code;
}

int OnInit() {
   terminal_session=NewSession();terminal_id=TerminalIdentity();ea_instance=terminal_id+StringFormat("%I64x",(ulong)ChartID());account_stamp=AccountStamp();order_permission=false;clock_anchor=0;clock_tick=GetTickCount64();
   if(terminal_id=="")return INIT_FAILED;
   if(!LoadConfig()) {
      Print("ROCKET1000 EA: use the personalized EA downloaded from your dashboard. No manual token or URL entry is required.");
      ShowStatus("Disconnected - connection configuration missing or invalid");
   }
   if(!EventSetTimer(1)) return INIT_FAILED;
   next_attempt=0;
   return INIT_SUCCEEDED;
}
void OnDeinit(const int reason) { EventKillTimer();Comment(""); }
void OnTimer() {
   ulong tick=GetTickCount64();
   if(tick<next_attempt) return;
   if(account_stamp!=AccountStamp()){account_stamp=AccountStamp();registered=false;order_permission=false;terminal_session=NewSession();pending_result="";active_id="";broker_anchor=0;quote_count=0;costs_until=0;performance_until=0;}
   if(!LoadConfig()) {registered=false;order_permission=false;ShowStatus("Disconnected - download the personalized EA again");next_attempt=tick+15000;return;}
   if(!TerminalInfoInteger(TERMINAL_CONNECTED) || AccountInfoInteger(ACCOUNT_LOGIN)<=0) {
      if(registered)terminal_session=NewSession();order_permission=false;
      registered=false;ShowStatus("Disconnected - log into the authorized MT5 broker account");next_attempt=tick+5000;return;
   }
   // Account validation is local. Never report it as an HTTP response from the backend.
   long mode=AccountInfoInteger(ACCOUNT_TRADE_MODE);
   if(mode!=ACCOUNT_TRADE_MODE_REAL && mode!=ACCOUNT_TRADE_MODE_DEMO) {
      registered=false;ShowStatus("Connection Error - use a demo or live MT5 account");next_attempt=tick+5000;return;
   }
   if(!registered) ShowStatus("Connecting");
   int code=SendTelemetry(!registered);
   if(code==200) { registered=true;retry_seconds=5;next_attempt=GetTickCount64()+5000;ShowStatus("Connected");return; }
   if(registered)terminal_session=NewSession();registered=false;order_permission=false;
   if(code==401) ShowStatus("Authentication Failed - download a replacement package");
   else if(code==403) ShowStatus("Account Mismatch - check the authorized MT5 account and server");
   else if(code!=-1 && code!=-2) ShowStatus("Disconnected - backend HTTP "+IntegerToString(code));
   next_attempt=GetTickCount64()+(ulong)retry_seconds*1000;
   retry_seconds=MathMin(retry_seconds*2,60);
}
void OnTick() {
   // Data observation only. No independent entry, exit, indicators or strategy decisions.
   MqlTick quote;FreshQuote(_Symbol,quote,15);
}
void OnTradeTransaction(const MqlTradeTransaction &transaction,const MqlTradeRequest &request,const MqlTradeResult &result){
   // Keep this callback bounded; no network, analysis or broker submissions here.
   performance_until=0;costs_until=0;next_attempt=GetTickCount64()+100;
   if(active_id=="" || account_stamp!=AccountStamp())return;
   string tag="R1000:"+StringSubstr(active_id,0,24);
   if(active_kind=="MODIFY"){
      if(transaction.type!=TRADE_TRANSACTION_REQUEST || request.magic!=100061 || request.comment!=tag || request.action!=TRADE_ACTION_SLTP || request.position!=active_position || result.retcode!=TRADE_RETCODE_DONE)return;
      double tick=SymbolInfoDouble(active_symbol,SYMBOL_TRADE_TICK_SIZE);
      if(tick>0 && PositionSelectByTicket(active_position) && PositionGetInteger(POSITION_MAGIC)==100061 && PositionGetString(POSITION_SYMBOL)==active_symbol && TicketString((ulong)PositionGetInteger(POSITION_IDENTIFIER))==active_identifier && MathAbs(PositionGetDouble(POSITION_SL)-active_stop)<tick/2 && MathAbs(PositionGetDouble(POSITION_TP)-active_tp)<tick/2)BrokerResult(active_id,active_lease,"executed",result.retcode,0,0,0,0,"position-state");
      return;
   }
   if(transaction.type!=TRADE_TRANSACTION_DEAL_ADD || transaction.deal==0 || !HistoryDealSelect(transaction.deal))return;
   if(HistoryDealGetInteger(transaction.deal,DEAL_MAGIC)!=100061 || HistoryDealGetString(transaction.deal,DEAL_SYMBOL)!=active_symbol)return;
   ulong order=(ulong)HistoryDealGetInteger(transaction.deal,DEAL_ORDER);
   if((active_order==0 || order!=active_order) && HistoryDealGetString(transaction.deal,DEAL_COMMENT)!=tag && HistoryOrderGetString(order,ORDER_COMMENT)!=tag)return;
   long type=HistoryDealGetInteger(transaction.deal,DEAL_TYPE),entry=HistoryDealGetInteger(transaction.deal,DEAL_ENTRY);
   if((type!=DEAL_TYPE_BUY && type!=DEAL_TYPE_SELL) || (active_kind=="OPEN" && entry!=DEAL_ENTRY_IN) || (active_kind=="CLOSE" && (entry!=DEAL_ENTRY_OUT && entry!=DEAL_ENTRY_OUT_BY)))return;
   if(active_kind=="CLOSE" && TicketString((ulong)HistoryDealGetInteger(transaction.deal,DEAL_POSITION_ID))!=active_identifier)return;
   for(int i=0;i<active_deal_count;i++)if(active_deals[i]==transaction.deal)return;
   if(active_deal_count>=128)return; // Larger fill sets remain uncertain until full broker-history reconciliation.
   double volume=HistoryDealGetDouble(transaction.deal,DEAL_VOLUME),price=HistoryDealGetDouble(transaction.deal,DEAL_PRICE);
   if(volume<=0 || price<=0 || !MathIsValidNumber(volume) || !MathIsValidNumber(price))return;
   active_deals[active_deal_count++]=transaction.deal;active_filled+=volume;active_value+=volume*price;
   double epsilon=MathMax(0.00000001,active_volume*0.00000001);
   if(active_filled>active_volume+epsilon)return;
   BrokerResult(active_id,active_lease,active_filled+epsilon<active_volume?"partial":"executed",0,transaction.deal,order,active_filled,active_value/active_filled,"broker-history");
}

