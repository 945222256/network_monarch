use serde::Deserialize;

#[derive(Deserialize, Debug)]
struct Geo {
    country_en: Option<String>,
    isp: Option<String>,
}

#[derive(Deserialize, Debug)]
struct HopResult {
    #[serde(rename = "Success")]
    success: bool,
    #[serde(rename = "Geo")]
    geo: Option<Geo>,
}

#[derive(Deserialize, Debug)]
struct TraceOutput {
    #[serde(rename = "Hops", alias = "Traceroute")]
    traceroute: Vec<Vec<HopResult>>,
}

fn main() {
    let json_str = r#"{"Hops":[[{"Success":true,"Address":{"IP":"141.198.250.90","Zone":""},"Hostname":"","TTL":24,"RTT":292637700,"Error":null,"Geo":{"ip":"","asnumber":"1761","country":"美国","country_en":"United States","prov":"德克萨斯州","prov_en":"Texas","city":"奥斯汀","city_en":"Austin","district":"","owner":"General Services Commission ","isp":"General Services Commission","domain":"","whois":"","lat":30.267152786254883,"lng":-97.74305725097656,"prefix":"","router":{},"source":""},"Lang":"cn","MPLS":null}]]}"#;

    let parsed: Result<TraceOutput, _> = serde_json::from_str(json_str);
    match parsed {
        Ok(p) => {
            println!("Parsed successfully: {:?}", p);
            for hop_group in p.traceroute.iter().rev() {
                for hop in hop_group.iter().rev() {
                    if hop.success {
                        if let Some(ref geo) = hop.geo {
                            println!("[Trace Debug] Parsed Geo data: {:?}", geo);
                            let mut c = geo.country_en.clone().unwrap_or_default();
                            let mut i = geo.isp.clone().unwrap_or_default();
                            println!("c: '{}', i: '{}'", c, i);
                        } else {
                            println!("Hop was successful but Geo was None");
                        }
                    } else {
                        println!("Hop was not successful");
                    }
                }
            }
        },
        Err(e) => println!("Parse error: {}", e),
    }
}
