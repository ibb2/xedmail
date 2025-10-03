using System.Text;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using xedmail.Mail;
using xedmail.Model;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
// Learn more about configuring OpenAPI at https://aka.ms/aspnet/openapi
builder.Services.AddOpenApi();

// At the top of Program.cs
// Add CORS
builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowNextJs", policy =>
    {
        policy.WithOrigins("http://localhost:3000")
            .AllowAnyHeader()
            .AllowAnyMethod();
    });
});

builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlite("Data Source=xedmail.db"));

var app = builder.Build();

// Create database on startup
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.EnsureCreated();
}

// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.UseHttpsRedirection();
app.UseCors("AllowNextJs");

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

app.MapGet("/oauth/callback", async (
    HttpContext ctx, 
    ILogger<Program> logger,
    AppDbContext db) =>
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
    
    logger.LogInformation("Exchanging authorization code for tokens");
    
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
    
    // Get user info
    var userInfoResponse = await http.GetAsync(
        $"https://www.googleapis.com/oauth2/v3/userinfo?access_token={json["access_token"]}");
    var userInfoJson = await userInfoResponse.Content.ReadFromJsonAsync<Dictionary<string, object>>();
    
    var userEmail = userInfoJson?["email"]?.ToString();
    if (string.IsNullOrEmpty(userEmail))
    {
        logger.LogError("Failed to get user email");
        return Results.Problem("Failed to get user information");
    }
    
    logger.LogInformation("Successfully obtained OAuth tokens for {Email}", userEmail);
    
    // Calculate expiry
    var expiresIn = int.Parse(json["expires_in"].ToString()!);
    var expiresAt = DateTime.UtcNow.AddSeconds(expiresIn);
    
    // Check if user already exists
    var existingToken = await db.UserTokens.FirstOrDefaultAsync(t => t.Email == userEmail);
    
    if (existingToken != null)
    {
        // Update existing
        existingToken.AccessToken = json["access_token"].ToString()!;
        existingToken.ExpiresAt = expiresAt;
        existingToken.UpdatedAt = DateTime.UtcNow;
        
        if (json.ContainsKey("refresh_token"))
        {
            existingToken.RefreshToken = json["refresh_token"].ToString();
        }
        
        logger.LogInformation("Updated existing tokens for {Email}", userEmail);
    }
    else
    {
        // Create new
        var newToken = new UserToken
        {
            UserId = userEmail, // Use email as user ID for now
            Email = userEmail,
            AccessToken = json["access_token"].ToString()!,
            RefreshToken = json.ContainsKey("refresh_token") ? json["refresh_token"].ToString() : null,
            ExpiresAt = expiresAt
        };
        
        db.UserTokens.Add(newToken);
        logger.LogInformation("Created new token record for {Email}", userEmail);
    }
    
    await db.SaveChangesAsync();
    
    // Redirect back to Next.js with user email
    var nextJsUrl = builder.Configuration["NextJs:BaseUrl"];
    return Results.Redirect($"{nextJsUrl}/auth/callback?email={Uri.EscapeDataString(userEmail)}");
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

// API endpoint to get all emails from the inbox
app.MapGet("/api/inbox/all", async (
    HttpContext ctx,
    ILogger<Program> logger,
    AppDbContext db,
    string email
    ) =>
{
    logger.LogInformation("Connecting {Email}'s inbox", email);
    if (string.IsNullOrEmpty(email))
    {
        logger.LogWarning("No email provided");
        return Results.BadRequest("Email required");
    }
    
    var userToken = await db.UserTokens.FirstOrDefaultAsync(t => t.Email == email);
    
    if (userToken == null)
    {
        logger.LogWarning("No token found for {Email}", email);
        return Results.NotFound("User not authenticated with Google");
    }
    
    // Check if token is expired
    if (userToken.ExpiresAt <= DateTime.UtcNow)
    {
        logger.LogWarning("Access token expired for {Email}", email);
        return Results.Problem("Access token expired. Please re-authenticate.");
    }
    
    logger.LogInformation("Fetching inbox for {Email}", email);
    
    MailClient mailClient = new();
    await mailClient.Connect(userToken.Email, userToken.AccessToken);
    var messages = await mailClient.GetInbox();
    
    logger.LogInformation("Got {Count} messages for {Email}", messages.Count, email);
    
    var emailDtos = messages.Select(m => new EmailDto
    {
        Id = m.MessageId ?? Guid.NewGuid().ToString(),
        Subject = m.Subject ?? "(No Subject)",
        From = m.From.Mailboxes.FirstOrDefault()?.Address ?? "unknown",
        To = string.Join(", ", m.To.Mailboxes.Select(mb => mb.Address)),
        Body = m.TextBody ?? m.HtmlBody ?? "(No Content)",
        Date = m.Date.UtcDateTime,
        IsRead = false // You'll need to get this from IMAP flags if available
    }).ToList();
    
    return Results.Ok(emailDtos);
});

app.Run();

record WeatherForecast(DateOnly Date, int TemperatureC, string? Summary)
{
    public int TemperatureF => 32 + (int)(TemperatureC / 0.5556);
}

// Add this class to your Program.cs
public class EmailDto
{
    public string Id { get; set; } = string.Empty;
    public string Subject { get; set; } = string.Empty;
    public string From { get; set; } = string.Empty;
    public string? To { get; set; }
    public string? Body { get; set; }
    public DateTime Date { get; set; }
    public bool IsRead { get; set; }
}