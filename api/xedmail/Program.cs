using xedmail.Models;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
// Learn more about configuring OpenAPI at https://aka.ms/aspnet/openapi
builder.Services.AddOpenApi();

// Register DbContext
builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlite("Data Source=app.db")); // or SQL Server/Postgres/etc

// At the top of Program.cs
builder.Services.AddDistributedMemoryCache();
builder.Services.AddSession(options =>
{
    options.IdleTimeout = TimeSpan.FromMinutes(30);
    options.Cookie.HttpOnly = true;
    options.Cookie.IsEssential = true;
    options.Cookie.SameSite = SameSiteMode.Lax;
});

var app = builder.Build();

// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.UseHttpsRedirection();
app.UseSession(); // Add this before your endpoints

var summaries = new[]
{
    "Freezing", "Bracing", "Chilly", "Cool", "Mild", "Warm", "Balmy", "Hot", "Sweltering", "Scorching"
};

app.MapGet("/", () => "Hello world!");

app.MapGet("/weatherforecast", () =>
    {
        var forecast = Enumerable.Range(1, 5).Select(index =>
                new WeatherForecast
                (
                    DateOnly.FromDateTime(DateTime.Now.AddDays(index)),
                    Random.Shared.Next(-20, 55),
                    summaries[Random.Shared.Next(summaries.Length)]
                ))
            .ToArray();
        return forecast;
    })
    .WithName("GetWeatherForecast");

app.MapGet("/oauth/callback", async (HttpContext ctx, ILogger<Program> logger) =>
{
    var code = ctx.Request.Query["code"].ToString();
    if (string.IsNullOrEmpty(code))
    {
        logger.LogWarning("OAuth callback received without authorization code");
        return Results.BadRequest("Missing code");
    }
    
    using var http = new HttpClient();
    
    var data = new Dictionary<string, string>
    {
        ["code"] = code,
        ["client_id"] = builder.Configuration["Google:ClientId"]!,
        ["client_secret"] = builder.Configuration["Google:ClientSecret"]!,
        ["redirect_uri"] = builder.Configuration["Google:RedirectUri"]!, 
        ["grant_type"] = "authorization_code"
    };
    
    // Log the request data (without sensitive info)
    logger.LogInformation("Exchanging authorization code for tokens. RedirectUri: {RedirectUri}", 
        data["redirect_uri"]);
    
    var tokenResponse = await http.PostAsync(
        "https://oauth2.googleapis.com/token",
        new FormUrlEncodedContent(data));
    
    if (!tokenResponse.IsSuccessStatusCode)
    {
        var errorContent = await tokenResponse.Content.ReadAsStringAsync();
        logger.LogError("Token exchange failed. Status: {StatusCode}, Response: {Response}", 
            tokenResponse.StatusCode, errorContent);
        return Results.Problem("Failed to exchange authorization code");
    }
    
    var json = await tokenResponse.Content.ReadFromJsonAsync<Dictionary<string, object>>();
    
    if (json == null)
    {
        logger.LogError("Failed to deserialize token response");
        return Results.Problem("Invalid token response");
    }
    
    logger.LogInformation("Successfully obtained OAuth tokens");
    
    // Store tokens in session
    ctx.Session.SetString("google_access_token", json["access_token"].ToString()!);
    if (json.ContainsKey("refresh_token"))
    {
        ctx.Session.SetString("google_refresh_token", json["refresh_token"].ToString()!);
    }

    
    // TODO: save refresh_token in DB linked to the Clerk user ID
    var nextJsUrl = builder.Configuration["NextJs:BaseUrl"];
    return Results.Redirect($"{nextJsUrl}/auth/callback?success=true");

    return Results.Ok(json);
});

// API endpoint to get tokens
app.MapGet("/api/tokens", (HttpContext ctx) =>
{
    var accessToken = ctx.Session.GetString("google_access_token");
    
    if (string.IsNullOrEmpty(accessToken))
        return Results.Unauthorized();
    
    return Results.Ok(new 
    { 
        access_token = accessToken,
        refresh_token = ctx.Session.GetString("google_refresh_token")
    });
});


app.Run();

record WeatherForecast(DateOnly Date, int TemperatureC, string? Summary)
{
    public int TemperatureF => 32 + (int)(TemperatureC / 0.5556);
}