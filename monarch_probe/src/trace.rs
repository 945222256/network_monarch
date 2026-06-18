use serde::Deserialize;
use std::process::Command;

#[derive(Deserialize, Debug)]
struct Geo {
    country_en: Option<String>,
    isp: Option<String>,
    #[serde(rename = "latitude")]
    lat: Option<f64>,
    #[serde(rename = "longitude")]
    lon: Option<f64>,
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

#[derive(Debug, Clone)]
pub struct TraceInfo {
    pub hops: usize,
    pub country: String,
    pub isp: String,
    pub lat: f32,
    pub lon: f32,
}

pub fn run_nexttrace(ip: &str) -> Option<TraceInfo> {
    // Run ntrace --json <IP>
    let output = Command::new("ntrace")
        .arg("--json")
        .arg("-M")
        .arg("-d")
        .arg("LeoMoeAPI")
        .arg(ip)
        .output()
        .ok()?;

    if !output.status.success() {
        eprintln!("[Trace Debug] ntrace failed with status: {}", output.status);
        return None;
    }

    let json_str = String::from_utf8_lossy(&output.stdout);
    
    // Find the first '{' to skip any preamble warnings like "cannot determine local IPv4 address"
    let json_start = json_str.find('{').unwrap_or(0);
    let clean_json = &json_str[json_start..];

    let parsed: TraceOutput = match serde_json::from_str(clean_json) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[Trace Debug] JSON parse error: {}. Output starts with: {:.200}", e, json_str);
            return None;
        }
    };

    let hops = parsed.traceroute.len();
    if hops == 0 {
        return None;
    }

    // Find the last successful hop with valid Geo info
    for hop_group in parsed.traceroute.iter().rev() {
        for hop in hop_group.iter().rev() {
            if hop.success {
                if let Some(ref geo) = hop.geo {
                    println!("[Trace Debug] Parsed Geo data: {:?}", geo);
                    let mut c = geo.country_en.clone().unwrap_or_default();
                    let mut i = geo.isp.clone().unwrap_or_default();
                    
                    if c.is_empty() && i.is_empty() {
                        continue;
                    }
                    if c.to_lowercase().contains("network error") || c.to_lowercase().contains("timeout") {
                        continue;
                    }

                    if c.is_empty() { c = "Unknown".to_string(); }
                    if i.is_empty() { i = "Unknown".to_string(); }

                    let lat = geo.lat.unwrap_or(0.0) as f32;
                    let lon = geo.lon.unwrap_or(0.0) as f32;

                    return Some(TraceInfo {
                        hops,
                        country: c,
                        isp: i,
                        lat,
                        lon,
                    });
                }
            }
        }
    }

    Some(TraceInfo {
        hops,
        country: "Unknown".to_string(),
        isp: "Unknown".to_string(),
        lat: 0.0,
        lon: 0.0,
    })
}
