#include <stdio.h>

extern int fetchlet_rust_probe(void);

int main(void){
    int result=fetchlet_rust_probe();
    printf("{\"rustStaticCalls\":%s,\"bootstrap\":\"C main / Zig GNU CRT\"}\n",result==0?"true":"false");
    return result;
}
